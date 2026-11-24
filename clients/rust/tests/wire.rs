//! Framing rules and forward compatibility, against a scripted driver on an in-memory pipe:
//! events of a type this client does not know (`x:vendor.ping`, and `session.hibernated` from a
//! newer ARI) reach the `Unrecognized` catch-all with their raw JSON instead of failing the
//! stream; the client answers the driver's `host/*` request while its own call is pending; items
//! sent in the same buffer as the response that starts their stream are not lost; and a driver
//! that goes away fails the pending call with `transport`.

use std::sync::Arc;
use std::time::Duration;

use ari_client::*;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
use tokio_stream::StreamExt;

struct ScriptedDriver {
    lines: tokio::io::Lines<BufReader<tokio::io::ReadHalf<DuplexStream>>>,
    writer: tokio::io::WriteHalf<DuplexStream>,
}

impl ScriptedDriver {
    async fn read(&mut self) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(5), self.lines.next_line()).await.expect("a frame within 5 s").unwrap().expect("a frame");
        serde_json::from_str(&line).unwrap()
    }

    /// Writes all `frames` in one write, so the client reads them from one buffer.
    async fn write(&mut self, frames: &[Value]) {
        let text: String = frames.iter().map(|frame| format!("{frame}\n")).collect();
        self.writer.write_all(text.as_bytes()).await.unwrap();
        self.writer.flush().await.unwrap();
    }
}

fn connect(host: Arc<dyn Host>) -> (Client, ScriptedDriver) {
    let (client_side, driver_side) = tokio::io::duplex(1 << 16);
    let (client_read, client_write) = tokio::io::split(client_side);
    let (driver_read, driver_write) = tokio::io::split(driver_side);
    let client = Client::connect(client_read, client_write, host);
    (client, ScriptedDriver { lines: BufReader::new(driver_read).lines(), writer: driver_write })
}

fn handshake_result() -> Value {
    let versions: serde_json::Map<String, Value> = METHOD_VERSIONS.iter().map(|(name, major, minor)| (name.to_string(), json!({ "major": major, "minor": minor }))).collect();
    json!({
        "ariVersion": ARI_VERSION, "grammarVersions": [1, 1], "methodVersions": versions, "persistenceVersion": { "major": 1, "minor": 0 },
        "grammarVersion": 1,
        "driver": { "kind": "scripted", "ariVersion": ARI_VERSION, "metadata": { "displayName": "Scripted", "multipleInstances": false, "hasDefaultInstance": false }, "configSchema": true }
    })
}

async fn initialized(host: Arc<dyn Host>) -> (Client, ScriptedDriver) {
    let (client, mut driver) = connect(host);
    let handshake = tokio::spawn({
        let client = client.clone();
        async move { client.initialize(EnvPolicy { strip_ambient: vec!["SECRET_*".to_owned()] }).await }
    });
    let initialize = driver.read().await;
    assert_eq!(initialize["method"], "initialize");
    assert_eq!(initialize["params"]["host"], json!({ "capabilities": { "process": false }, "envPolicy": { "stripAmbient": ["SECRET_*"] } }));
    assert_eq!(initialize["params"]["methodVersions"]["session/startTurn"], json!({ "major": 1, "minor": 0 }));
    driver.write(&[json!({ "jsonrpc": "2.0", "id": initialize["id"], "result": handshake_result() })]).await;
    handshake.await.unwrap().expect("initialize");
    (client, driver)
}

#[tokio::test]
async fn unknown_event_types_reach_the_catch_all_and_known_ones_still_decode() {
    let host = Arc::new(MemoryHost::new());
    let (client, mut driver) = initialized(host.clone()).await;
    let subscribe = tokio::spawn({
        let client = client.clone();
        async move { client.session_events(&SessionEventsParams { session_id: "s-1".to_owned(), from_seq: None }).await }
    });
    let request = driver.read().await;
    assert_eq!(request["method"], "session/events");
    let ping = json!({ "type": "x:vendor.ping", "data": { "n": 1 }, "fallback": { "title": "Ping" } });
    let hibernated = json!({ "type": "session.hibernated", "until": "tomorrow" });
    let event = |seq: u32, body: Value| json!({ "jsonrpc": "2.0", "method": "ari/event", "params": { "streamId": "d1", "event": { "seq": seq, "at": "2026-11-23T00:00:00.000Z", "sessionId": "s-1", "body": body } } });
    driver
        .write(&[
            json!({ "jsonrpc": "2.0", "id": request["id"], "result": { "streamId": "d1" } }),
            event(1, ping.clone()),
            event(2, hibernated.clone()),
            event(3, json!({ "type": "turn.terminal", "turnId": "t-1", "status": "paused", "threadDisposition": "reusable" })),
            json!({ "jsonrpc": "2.0", "method": "stream/end", "params": { "streamId": "d1" } }),
        ])
        .await;
    let events: Vec<AriEvent> = subscribe.await.unwrap().expect("session/events").map(|item| item.expect("every event decodes")).collect().await;
    assert_eq!(events.len(), 3);
    match &events[0].body {
        AriEventBody::Unrecognized(raw) => assert_eq!(raw, &ping),
        other => panic!("x:vendor.ping should reach the catch-all, got {other:?}"),
    }
    assert_eq!(events[0].body.tag(), Some("x:vendor.ping"));
    match &events[1].body {
        AriEventBody::Unrecognized(raw) => assert_eq!(raw, &hibernated),
        other => panic!("session.hibernated should reach the catch-all, got {other:?}"),
    }
    let AriEventBody::TurnTerminal(terminal) = &events[2].body else { panic!("turn.terminal decodes as its own variant") };
    // An unknown enum value is kept too.
    assert_eq!(terminal.status, TurnTerminalStatus::Unrecognized("paused".to_owned()));
    // And everything goes back on the wire as it came.
    assert_eq!(serde_json::to_value(&events[0].body).unwrap(), ping);
    assert_eq!(serde_json::to_value(&events[2].body).unwrap()["status"], "paused");
}

#[tokio::test]
async fn the_host_answers_the_driver_while_a_call_is_pending() {
    let host = Arc::new(MemoryHost::new().with_config("i-1", json!({ "binary": "x" })));
    let (client, mut driver) = initialized(host.clone()).await;
    let call = tokio::spawn({
        let client = client.clone();
        async move { client.instance_probe(&InstanceProbeParams { instance_id: "i-1".to_owned(), deep: None }).await }
    });
    let probe = driver.read().await;
    assert_eq!(probe["method"], "instance/probe");
    // Before answering, the driver asks the host for three things.
    driver
        .write(&[
            json!({ "jsonrpc": "2.0", "id": 1, "method": "host/config.get", "params": { "instanceId": "i-1", "watch": true } }),
            json!({ "jsonrpc": "2.0", "id": 2, "method": "host/secrets.get", "params": { "instanceId": "i-1", "namespace": "n", "key": "k" } }),
            json!({ "jsonrpc": "2.0", "id": 3, "method": "host/process.spawn", "params": { "instanceId": "i-1", "processId": "p1", "command": "x", "purpose": "probe" } }),
            json!({ "jsonrpc": "2.0", "id": 4, "method": "host/diagnostics.log", "params": { "instanceId": "i-1", "level": "warn", "msg": "hello" } }),
        ])
        .await;
    let mut answers = std::collections::BTreeMap::new();
    let mut config_stream_end = None;
    while answers.len() < 4 || config_stream_end.is_none() {
        let frame = driver.read().await;
        if frame["method"] == "stream/end" {
            config_stream_end = Some(frame["params"]["streamId"].clone());
        } else {
            answers.insert(frame["id"].as_u64().unwrap(), frame);
        }
    }
    let config = &answers[&1]["result"];
    assert_eq!(config["config"], json!({ "binary": "x" }));
    // A watch is answered with a stream that ends at once.
    assert_eq!(config_stream_end.as_ref(), Some(&config["streamId"]));
    assert_eq!(answers[&2]["result"], Value::Null);
    assert_eq!(answers[&3]["error"]["data"]["code"], "unsupported");
    assert_eq!(answers[&4]["result"], Value::Null);
    assert_eq!(host.diagnostics()[0].msg, "hello");
    driver.write(&[json!({ "jsonrpc": "2.0", "id": probe["id"], "result": { "ok": true, "installed": true, "checkedAt": "2026-11-23T00:00:00.000Z" } })]).await;
    let result = call.await.unwrap().expect("instance/probe");
    assert!(result.installed);
}

#[tokio::test]
async fn a_driver_that_goes_away_fails_pending_calls_with_transport() {
    let (client, mut driver) = initialized(Arc::new(MemoryHost::new())).await;
    let call = tokio::spawn({
        let client = client.clone();
        async move { client.instance_status(&InstanceTarget { instance_id: "i-1".to_owned() }).await }
    });
    let request = driver.read().await;
    assert_eq!(request["method"], "instance/status");
    drop(driver);
    let error = call.await.unwrap().expect_err("the call fails");
    assert!(matches!(error, CallError::Transport(_)), "{error:?}");
    let later = client.instance_status(&InstanceTarget { instance_id: "i-1".to_owned() }).await.expect_err("later calls fail too");
    assert!(matches!(later, CallError::Transport(_)), "{later:?}");
}

#[test]
fn call_errors_and_unknown_codes_round_trip() {
    let unsupported: CallError = serde_json::from_value(json!({ "code": "unsupported", "message": "no", "capability": "threads.fork" })).unwrap();
    assert!(matches!(&unsupported, CallError::Unsupported(error) if error.capability == "threads.fork"));
    let extension = json!({ "code": "x:vendor.quota", "message": "slow down", "detail": 3 });
    let decoded: CallError = serde_json::from_value(extension.clone()).unwrap();
    assert!(matches!(&decoded, CallError::Unrecognized(raw) if raw == &extension));
    assert_eq!(serde_json::to_value(&decoded).unwrap(), extension);
}
