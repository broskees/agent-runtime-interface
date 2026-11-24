//! The Rust client drives the real `pi` and `acp` drivers inside the standalone `ari-driver`
//! (built by `pnpm run build:binary` into build/standalone/linux-x64/), with a PATH that holds no
//! `node` and no `bun`: initialize, probe the instance, open a session, create a thread, start a
//! turn, answer its approval through `respond`, and read events until `turn.terminal` completes.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use ari_client::*;
use serde_json::{json, Value};
use tokio::process::Command;
use tokio_stream::StreamExt;

fn standalone_dir() -> PathBuf {
    match std::env::var_os("ARI_STANDALONE_DIR") {
        Some(directory) => PathBuf::from(directory),
        None => Path::new(env!("CARGO_MANIFEST_DIR")).join("../../build/standalone/linux-x64"),
    }
}

fn binary(relative: &str) -> PathBuf {
    let path = standalone_dir().join(relative);
    assert!(path.is_file(), "{} is missing; run `pnpm run build:binary` first", path.display());
    path.canonicalize().unwrap()
}

/// A temp directory with `bin/` (only `pi`, the compiled fake), `home/`, `project/` and the
/// instance's `state/`, `cache/` and `tmp/`. Removed on drop.
struct NodeFree {
    root: PathBuf,
}

static COUNTER: AtomicU32 = AtomicU32::new(0);

impl NodeFree {
    fn new() -> Self {
        let name = format!("ari-rust-client-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst));
        let root = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&root);
        for directory in ["bin", "home", "project", "state", "cache", "tmp"] {
            std::fs::create_dir_all(root.join(directory)).unwrap();
        }
        let root = root.canonicalize().unwrap();
        std::os::unix::fs::symlink(binary("fakes/pi"), root.join("bin/pi")).unwrap();
        for runtime in ["node", "nodejs", "bun"] {
            assert!(!root.join("bin").join(runtime).exists(), "the PATH must hold no {runtime}");
        }
        NodeFree { root }
    }

    fn path(&self, relative: &str) -> String {
        self.root.join(relative).to_string_lossy().into_owned()
    }

    /// `ari-driver <driver>` with an environment that holds only PATH (no node, no bun), HOME and XDG dirs.
    fn command(&self, driver: &str) -> Command {
        let mut command = Command::new(binary("ari-driver"));
        command.arg(driver).env_clear().current_dir(self.path("project"));
        command.env("PATH", self.path("bin")).env("HOME", self.path("home"));
        for (variable, relative) in [("XDG_CONFIG_HOME", "home/.config"), ("XDG_DATA_HOME", "home/.local/share"), ("XDG_STATE_HOME", "home/.local/state"), ("XDG_CACHE_HOME", "home/.cache")] {
            command.env(variable, self.path(relative));
        }
        command
    }
}

impl Drop for NodeFree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

async fn complete_a_turn(driver: &str, config: Value, option_id: &str, expected_version: &str) {
    let place = NodeFree::new();
    let instance_key = format!("{driver}-rust");
    let host = Arc::new(MemoryHost::new().with_config(&instance_key, config.clone()));
    let client = Client::spawn(place.command(driver), host.clone()).expect("ari-driver starts");

    let handshake = client.initialize(EnvPolicy { strip_ambient: vec![] }).await.expect("initialize");
    assert_eq!(handshake.driver.kind, driver);
    assert_eq!(handshake.grammar_version, 1);

    let instance = client
        .driver_create(&DriverCreateParams {
            instance_id: instance_key.clone(),
            config,
            environment: BTreeMap::new(),
            paths: HostPaths { state_dir: place.path("state"), cache_dir: place.path("cache"), tmp_dir: place.path("tmp") },
            ..Default::default()
        })
        .await
        .expect("driver/create");
    let probe = client.instance_probe(&InstanceProbeParams { instance_id: instance.instance_id.clone(), ..Default::default() }).await.expect("instance/probe");
    assert!(probe.installed, "{probe:?}");
    assert_eq!(probe.version.as_deref(), Some(expected_version));

    let session = client.instance_open_session(&InstanceOpenSessionParams { instance_id: instance.instance_id.clone(), ..Default::default() }).await.expect("instance/openSession");
    let mut events = client.session_events(&SessionEventsParams { session_id: session.session_id.clone(), ..Default::default() }).await.expect("session/events");

    let project = place.path("project");
    let policy = RuntimePolicy { mode: RuntimeMode::ApprovalRequired, interaction: InteractionMode::Default, cwd: project.clone(), additional_roots: None, native: None };
    let thread = client
        .session_create_thread(&SessionCreateThreadParams { session_id: session.session_id.clone(), cwd: project.clone(), policy, config: None, launch: None, title: None, force_new: None, persist_session: None, context: None })
        .await
        .expect("session/createThread");
    let started = client
        .session_start_turn(&SessionStartTurnParams {
            session_id: session.session_id.clone(),
            thread_id: thread.id.clone(),
            client_turn_key: "rust-1".to_owned(),
            intent: StartTurnIntent::Start,
            expected_turn_id: None,
            clear_pending_permissions: None,
            content: vec![ContentBlock::Text(TextContent { text: "Say hello".to_owned() })],
            context: None,
            config: None,
            policy: None,
            host_tag: None,
        })
        .await
        .expect("session/startTurn");
    let StartTurnResult::Accepted(accepted) = started else { panic!("the turn was not accepted: {started:?}") };

    let mut answered = None;
    let terminal = tokio::time::timeout(Duration::from_secs(20), async {
        while let Some(event) = events.next().await {
            let event = event.expect("an event this client can read");
            match event.body {
                AriEventBody::RequestUpsert(RequestUpsertBody { request }) if request.status == Some(RequestStatus::Pending) => {
                    let options = request.options.clone().flatten().unwrap_or_default();
                    assert!(options.iter().any(|option| option.option_id == option_id), "{options:?}");
                    client
                        .session_respond(&SessionRespondParams {
                            session_id: session.session_id.clone(),
                            request_id: request.id.clone(),
                            response_key: "rust-answer".to_owned(),
                            option_id: Some(option_id.to_owned()),
                            answers: None,
                            feedback: None,
                            custom: None,
                            scope: None,
                        })
                        .await
                        .expect("session/respond");
                    answered = Some(request.id);
                }
                AriEventBody::TurnTerminal(body) => return body,
                _ => {}
            }
        }
        panic!("the event stream ended before turn.terminal");
    })
    .await
    .expect("turn.terminal within 20 s");
    assert_eq!(terminal.turn_id, accepted.turn_id);
    assert_eq!(terminal.status, TurnTerminalStatus::Completed);
    assert!(answered.is_some(), "the approval request reached the client and was answered");

    client.session_close(&SessionTarget { session_id: session.session_id.clone() }).await.expect("session/close");
    client.instance_dispose(&InstanceTarget { instance_id: instance.instance_id.clone() }).await.expect("instance/dispose");
    client.close().await;
    assert!(!place.root.join("home/.pi").exists(), "the fake pi wrote under the user's ~/.pi");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pi_completes_a_turn_with_an_approval_without_node() {
    complete_a_turn("pi", json!({ "binary": "pi", "provider": "fake", "model": "fake/fake-small" }), "allow-once", "1.6.0").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn acp_completes_a_turn_with_an_approval_without_node() {
    let agent = binary("fakes/standalone-acp-agent");
    let config = json!({ "command": agent, "args": [], "env": {}, "versionArgs": ["--version"], "maxProtocolVersion": 1, "forkAcrossDirectories": false, "configDependencies": {} });
    complete_a_turn("acp", config, "allow", "1.0.0").await;
}
