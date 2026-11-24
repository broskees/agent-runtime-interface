//! The framing: newline-delimited JSON-RPC 2.0 in both directions, as docs/wire.md describes.
//!
//! - Our requests get ids 1, 2, 3, ...; the driver's requests (`host/*`) are answered by the
//!   `Host` while our own calls are still pending, each in its own task, so a driver that calls
//!   the host before it answers us never deadlocks.
//! - A stream (`session/events`, ...) is registered by the reader when the response carrying its
//!   `streamId` arrives, before the reader looks at the next frame, so no item is lost.
//! - When the driver's output ends, every pending call and every open stream fails with
//!   `transport`.

use std::collections::{HashMap, HashSet};
use std::marker::PhantomData;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

use crate::generated::*;

type Answer = Result<Value, CallError>;
type Items = mpsc::UnboundedSender<Result<Value, CallError>>;
type Writer = Box<dyn AsyncWrite + Unpin + Send>;

/// The JSON-RPC error code for a call error the callee threw.
const CALL_ERROR_CODE: i64 = -32000;
/// The JSON-RPC error code for a method the callee does not have.
const METHOD_NOT_FOUND: i64 = -32601;
/// The methods no connection works without.
const CORE_METHODS: [&str; 3] = ["initialize", "stream/end", "stream/cancel"];

struct Pending {
    answer: oneshot::Sender<Answer>,
    /// For a call that starts a stream: where its items go once the response names the stream.
    stream: Option<Items>,
}

#[derive(Default)]
struct Shared {
    pending: HashMap<u64, Pending>,
    streams: HashMap<String, Items>,
    closed: Option<CallError>,
    refused: HashSet<String>,
}

struct Inner {
    writer: tokio::sync::Mutex<Option<Writer>>,
    shared: Mutex<Shared>,
    next_id: AtomicU64,
    next_host_stream: AtomicU64,
    host: Arc<dyn Host>,
    child: tokio::sync::Mutex<Option<Child>>,
}

/// One connection to an ARI driver. Cloning shares the connection.
#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

impl Client {
    /// Starts `command` (an `ari-driver <driver>` invocation, such as the standalone executable)
    /// and connects to it over its stdin and stdout. Set its environment and working directory on
    /// `command`; stderr is left as `command` has it.
    pub fn spawn(mut command: Command, host: Arc<dyn Host>) -> Result<Client, CallError> {
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).kill_on_drop(true);
        let mut child = command.spawn().map_err(|error| transport(&format!("could not start ari-driver: {error}")))?;
        let stdin = child.stdin.take().ok_or_else(|| transport("ari-driver has no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| transport("ari-driver has no stdout"))?;
        let client = Client::connect(stdout, stdin, host);
        client.inner.child.try_lock().expect("a new client's child slot is free").replace(child);
        Ok(client)
    }

    /// Connects over any byte streams: `reader` carries the driver's frames, `writer` takes ours.
    pub fn connect<R, W>(reader: R, writer: W, host: Arc<dyn Host>) -> Client
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let inner = Arc::new(Inner {
            writer: tokio::sync::Mutex::new(Some(Box::new(writer))),
            shared: Mutex::new(Shared::default()),
            next_id: AtomicU64::new(1),
            next_host_stream: AtomicU64::new(1),
            host,
            child: tokio::sync::Mutex::new(None),
        });
        tokio::spawn(read_loop(inner.clone(), reader));
        Client { inner }
    }

    /// The handshake. Offers every method of methods.json at its version and no process
    /// delegation: the driver spawns its agents itself, with `env_policy` applied. Methods whose
    /// major version differs, or that the driver does not list, are refused locally afterwards.
    pub async fn initialize(&self, env_policy: EnvPolicy) -> Result<InitializeResult, CallError> {
        let params = InitializeParams {
            ari_version: ARI_VERSION.to_owned(),
            grammar_versions: (1, 1),
            method_versions: METHOD_VERSIONS.iter().map(|(name, major, minor)| (name.to_string(), Version { major: *major as i64, minor: *minor as i64 })).collect(),
            persistence_version: Version { major: 1, minor: 0 },
            host: InitializeParamsHost { capabilities: HostCapabilities { process: false }, env_policy: Some(env_policy) },
        };
        let result: InitializeResult = self.call("initialize", &params).await?;
        if major_of(&result.ari_version) != major_of(ARI_VERSION) {
            return Err(protocol("ari_version_mismatch", &format!("the driver speaks ARI {}, this client {}", result.ari_version, ARI_VERSION)));
        }
        if result.grammar_version != 1 {
            return Err(protocol("grammar_version_mismatch", &format!("the driver chose grammar version {}, this client reads 1", result.grammar_version)));
        }
        let mut refused = HashSet::new();
        for (name, major, _) in METHOD_VERSIONS {
            let same = result.method_versions.get(*name).is_some_and(|version| version.major == *major as i64);
            if !same {
                if CORE_METHODS.contains(name) {
                    return Err(protocol("core_method_missing", &format!("the driver does not speak {name} at major version {major}")));
                }
                refused.insert(name.to_string());
            }
        }
        self.inner.shared.lock().unwrap().refused = refused;
        Ok(result)
    }

    /// Closes our side, waits up to ten seconds for `ari-driver` to dispose its instances and
    /// exit, then kills it.
    pub async fn close(&self) {
        drop(self.inner.writer.lock().await.take());
        if let Some(mut child) = self.inner.child.lock().await.take() {
            if tokio::time::timeout(Duration::from_secs(10), child.wait()).await.is_err() {
                let _ = child.kill().await;
            }
        }
    }

    pub(crate) async fn call<P: Serialize, R: DeserializeOwned>(&self, method: &str, params: &P) -> Result<R, CallError> {
        let value = self.request(method, params, None).await?;
        serde_json::from_value(value).map_err(|error| protocol("invalid_result", &format!("{method} answered something this client cannot read: {error}")))
    }

    pub(crate) async fn subscribe<P: Serialize, T: DeserializeOwned>(&self, method: &str, params: &P, _notification: &str, item_field: &'static str) -> Result<Subscription<T>, CallError> {
        let (sender, items) = mpsc::unbounded_channel();
        let started: StreamStarted = serde_json::from_value(self.request(method, params, Some(sender)).await?).map_err(|error| protocol("invalid_result", &error.to_string()))?;
        Ok(Subscription { stream_id: started.stream_id, item_field, items, client: self.clone(), item: PhantomData })
    }

    async fn request<P: Serialize>(&self, method: &str, params: &P, stream: Option<Items>) -> Answer {
        let params = serde_json::to_value(params).map_err(|error| validation(&error.to_string()))?;
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        let (answer, answered) = oneshot::channel();
        {
            let mut shared = self.inner.shared.lock().unwrap();
            if let Some(error) = &shared.closed {
                return Err(error.clone());
            }
            if shared.refused.contains(method) {
                return Err(unsupported(method, "the handshake refused this method"));
            }
            shared.pending.insert(id, Pending { answer, stream });
        }
        if let Err(error) = self.inner.write(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await {
            self.inner.shared.lock().unwrap().pending.remove(&id);
            return Err(error);
        }
        answered.await.unwrap_or_else(|_| Err(transport("the connection closed")))
    }
}

/// The items of one stream, in order: a tokio `Stream` of `Result<T, CallError>`. It ends after
/// the driver's `stream/end`; a stream that failed yields its error last.
pub struct Subscription<T> {
    stream_id: String,
    item_field: &'static str,
    items: mpsc::UnboundedReceiver<Result<Value, CallError>>,
    client: Client,
    item: PhantomData<fn() -> T>,
}

impl<T> Subscription<T> {
    pub fn stream_id(&self) -> &str {
        &self.stream_id
    }

    /// Asks the driver to stop the stream; it then sends `stream/end`.
    pub async fn cancel(&self) -> Result<(), CallError> {
        self.client.call::<_, ()>("stream/cancel", &StreamCancelParams { stream_id: self.stream_id.clone() }).await
    }
}

impl<T: DeserializeOwned> tokio_stream::Stream for Subscription<T> {
    type Item = Result<T, CallError>;

    fn poll_next(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        match this.items.poll_recv(context) {
            Poll::Ready(Some(Ok(params))) => {
                let item = params.get(this.item_field).cloned().unwrap_or(Value::Null);
                Poll::Ready(Some(serde_json::from_value(item).map_err(|error| protocol("invalid_stream_item", &error.to_string()))))
            }
            Poll::Ready(Some(Err(error))) => Poll::Ready(Some(Err(error))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

async fn read_loop<R: AsyncRead + Unpin>(inner: Arc<Inner>, reader: R) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        // A line that is not JSON is the driver's mistake; the connection goes on.
        if let Ok(frame) = serde_json::from_str::<Value>(&line) {
            inner.handle(frame);
        }
    }
    inner.close(transport("the ari-driver process closed its output"));
}

impl Inner {
    async fn write(&self, frame: &Value) -> Result<(), CallError> {
        let mut text = serde_json::to_string(frame).map_err(|error| validation(&error.to_string()))?;
        text.push('\n');
        let mut writer = self.writer.lock().await;
        let writer = writer.as_mut().ok_or_else(|| transport("the connection is closed"))?;
        writer.write_all(text.as_bytes()).await.map_err(|error| transport(&format!("could not write to ari-driver: {error}")))?;
        writer.flush().await.map_err(|error| transport(&format!("could not write to ari-driver: {error}")))
    }

    fn handle(self: &Arc<Self>, frame: Value) {
        let method = frame.get("method").and_then(Value::as_str).map(str::to_owned);
        let params = frame.get("params").cloned().unwrap_or_else(|| json!({}));
        match (method, frame.get("id").cloned()) {
            (Some(method), Some(id)) if !id.is_null() => {
                let inner = self.clone();
                tokio::spawn(async move { inner.answer(id, &method, params).await });
            }
            (Some(method), _) => self.notification(&method, params),
            (None, Some(Value::Number(id))) => {
                if let Some(id) = id.as_u64() {
                    self.response(id, &frame);
                }
            }
            _ => {}
        }
    }

    fn response(&self, id: u64, frame: &Value) {
        let mut shared = self.shared.lock().unwrap();
        let Some(pending) = shared.pending.remove(&id) else { return };
        let answer = match frame.get("error") {
            Some(error) => Err(call_error_of(error)),
            None => Ok(frame.get("result").cloned().unwrap_or(Value::Null)),
        };
        if let (Ok(result), Some(items)) = (&answer, pending.stream) {
            if let Some(stream_id) = result.get("streamId").and_then(Value::as_str) {
                shared.streams.insert(stream_id.to_owned(), items);
            }
        }
        let _ = pending.answer.send(answer);
    }

    fn notification(&self, method: &str, params: Value) {
        let Some(stream_id) = params.get("streamId").and_then(Value::as_str).map(str::to_owned) else { return };
        let mut shared = self.shared.lock().unwrap();
        if method == "stream/end" {
            if let Some(items) = shared.streams.remove(&stream_id) {
                if let Some(error) = params.get("error") {
                    let _ = items.send(Err(serde_json::from_value(error.clone()).unwrap_or_else(|_| protocol("invalid_stream_end", &error.to_string()))));
                }
            }
            return;
        }
        // An item for a stream we do not know is dropped, as the wire says.
        if let Some(items) = shared.streams.get(&stream_id) {
            let _ = items.send(Ok(params));
        }
    }

    async fn answer(&self, id: Value, method: &str, params: Value) {
        let watch = method == "host/config.get" && params.get("watch").and_then(Value::as_bool) == Some(true);
        let answer = match method {
            // This client starts no streams the driver could cancel: a config watch ends at once.
            "stream/cancel" => Ok(Value::Null),
            _ if !HOST_METHODS.contains(&method) => Err((METHOD_NOT_FOUND, unsupported(method, "no such host method"))),
            _ => dispatch_host(self.host.as_ref(), method, params).await.map_err(|error| (CALL_ERROR_CODE, error)),
        };
        let mut ended_stream = None;
        let frame = match answer {
            Ok(mut result) => {
                if watch && result.get("streamId").is_none() {
                    // A host with nothing to watch still starts the stream and ends it at once.
                    let stream_id = format!("host-config-{}", self.next_host_stream.fetch_add(1, Ordering::SeqCst));
                    result["streamId"] = json!(stream_id);
                    ended_stream = Some(stream_id);
                }
                json!({ "jsonrpc": "2.0", "id": id, "result": result })
            }
            Err((code, error)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": error.to_string(), "data": error } }),
        };
        if self.write(&frame).await.is_ok() {
            if let Some(stream_id) = ended_stream {
                let _ = self.write(&json!({ "jsonrpc": "2.0", "method": "stream/end", "params": { "streamId": stream_id } })).await;
            }
        }
    }

    fn close(&self, error: CallError) {
        let mut shared = self.shared.lock().unwrap();
        shared.closed = Some(error.clone());
        for (_, pending) in shared.pending.drain() {
            let _ = pending.answer.send(Err(error.clone()));
        }
        for (_, items) in shared.streams.drain() {
            let _ = items.send(Err(error.clone()));
        }
    }
}

/// The call error in a JSON-RPC error: its `data` when that is one, else one made from the code.
fn call_error_of(error: &Value) -> CallError {
    let message = error.get("message").and_then(Value::as_str).unwrap_or("the driver refused the call");
    if let Some(data) = error.get("data") {
        if let Ok(call_error) = serde_json::from_value::<CallError>(data.clone()) {
            return call_error;
        }
    }
    match error.get("code").and_then(Value::as_i64) {
        Some(METHOD_NOT_FOUND) => unsupported("unknown", message),
        Some(-32602) => validation(message),
        _ => protocol("jsonrpc_error", message),
    }
}

fn major_of(version: &str) -> &str {
    version.split('.').next().unwrap_or(version)
}

pub fn unsupported(capability: &str, message: &str) -> CallError {
    CallError::Unsupported(UnsupportedError { message: format!("{capability}: {message}"), retryable: None, capability: capability.to_owned() })
}

pub fn validation(message: &str) -> CallError {
    CallError::Validation(ValidationError { message: message.to_owned(), retryable: None, issues: None })
}

pub fn protocol(detail: &str, message: &str) -> CallError {
    CallError::Protocol(ProtocolError { message: message.to_owned(), retryable: None, detail: detail.to_owned() })
}

pub fn transport(message: &str) -> CallError {
    CallError::Transport(TransportError { message: message.to_owned(), retryable: None })
}

impl std::fmt::Display for CallError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let value = serde_json::to_value(self).unwrap_or(Value::Null);
        let code = value.get("code").and_then(Value::as_str).unwrap_or("error");
        let message = value.get("message").and_then(Value::as_str).unwrap_or("");
        write!(formatter, "{code}: {message}")
    }
}

impl std::error::Error for CallError {}

/// A host that keeps everything in memory: each instance's config (`with_config`), secrets,
/// coordination leases and the diagnostics the driver logs. Background work may always run; no
/// attachments resolve. The other host services refuse with `unsupported`.
#[derive(Default)]
pub struct MemoryHost {
    configs: Mutex<HashMap<String, Value>>,
    secrets: Mutex<HashMap<(String, String, String), SecretValue>>,
    leases: Mutex<HashMap<String, (String, Instant)>>,
    next_lease: AtomicU64,
    diagnostics: Mutex<Vec<HostDiagnosticsLogParams>>,
}

impl MemoryHost {
    pub fn new() -> Self {
        Self::default()
    }

    /// The config `host/config.get` answers for `instance_id`, the id the host gives `driver/create`.
    pub fn with_config(self, instance_id: &str, config: Value) -> Self {
        self.configs.lock().unwrap().insert(instance_id.to_owned(), config);
        self
    }

    /// Every diagnostic the driver logged, in order.
    pub fn diagnostics(&self) -> Vec<HostDiagnosticsLogParams> {
        self.diagnostics.lock().unwrap().clone()
    }
}

impl Host for MemoryHost {
    fn config_get(&self, params: HostConfigGetParams) -> HostFuture<'_, HostConfigGetResult> {
        let config = self.configs.lock().unwrap().get(&params.instance_id).cloned();
        Box::pin(async move {
            let config = config.ok_or_else(|| CallError::NotFound(NotFoundError { message: format!("no config for instance {}", params.instance_id), retryable: None, resource: Some("instance".to_owned()), id: Some(params.instance_id.clone()) }))?;
            Ok(HostConfigGetResult { config, stream_id: None })
        })
    }

    fn secrets_get(&self, params: HostSecretParams) -> HostFuture<'_, NullableSecretValue> {
        let value = self.secrets.lock().unwrap().get(&(params.instance_id, params.namespace, params.key)).cloned();
        Box::pin(async move { Ok(value) })
    }

    fn secrets_set(&self, params: HostSecretsSetParams) -> HostFuture<'_, VoidResult> {
        self.secrets.lock().unwrap().insert((params.instance_id, params.namespace, params.key), params.value);
        Box::pin(async { Ok(()) })
    }

    fn secrets_delete(&self, params: HostSecretParams) -> HostFuture<'_, VoidResult> {
        self.secrets.lock().unwrap().remove(&(params.instance_id, params.namespace, params.key));
        Box::pin(async { Ok(()) })
    }

    fn attachments_resolve(&self, _params: HostAttachmentParams) -> HostFuture<'_, NullableAttachmentInfo> {
        Box::pin(async { Ok(None) })
    }

    fn background_should_run(&self, _params: HostBackgroundShouldRunParams) -> HostFuture<'_, BooleanResult> {
        Box::pin(async { Ok(true) })
    }

    fn coordination_acquire(&self, params: HostCoordinationAcquireParams) -> HostFuture<'_, NullableLease> {
        let now = Instant::now();
        let mut leases = self.leases.lock().unwrap();
        let held = leases.values().any(|(key, until)| *key == params.key && *until > now);
        let lease = if held {
            None
        } else {
            let lease_id = format!("lease-{}", self.next_lease.fetch_add(1, Ordering::SeqCst) + 1);
            let ttl = Duration::from_millis(params.ttl_ms.max(1) as u64);
            leases.insert(lease_id.clone(), (params.key.clone(), now + ttl));
            Some(Lease { lease_id, key: params.key, expires_at: iso8601(SystemTime::now() + ttl) })
        };
        Box::pin(async move { Ok(lease) })
    }

    fn coordination_release(&self, params: HostCoordinationReleaseParams) -> HostFuture<'_, VoidResult> {
        self.leases.lock().unwrap().remove(&params.lease_id);
        Box::pin(async { Ok(()) })
    }

    fn diagnostics_log(&self, params: HostDiagnosticsLogParams) -> HostFuture<'_, VoidResult> {
        self.diagnostics.lock().unwrap().push(params);
        Box::pin(async { Ok(()) })
    }
}

/// `time` as an ISO-8601 UTC timestamp with milliseconds.
fn iso8601(time: SystemTime) -> String {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = since.as_secs() as i64;
    let (days, rest) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", rest / 3600, rest % 3600 / 60, rest % 60, since.subsec_millis())
}
