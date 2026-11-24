"""The framing: newline-delimited JSON-RPC 2.0 in both directions, as docs/wire.md describes.

- Our requests get ids 1, 2, 3, ...; the driver's requests (`host/*`) are answered by the `Host`
  in their own tasks while our own calls are pending, so a driver that calls the host before it
  answers us never deadlocks.
- A stream (`session/events`, ...) is registered by the reader when the response carrying its
  `streamId` arrives, before the reader looks at the next frame, so no item is lost.
- When the driver's output ends, every pending call and every open stream fails with `transport`.
"""

from __future__ import annotations

import asyncio
import base64
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from ._codec import AriCallError, WireDecodeError, encode, protocol, transport, unsupported, validation
from ._generated import (
    ARI_VERSION,
    HOST_METHODS,
    METHOD_VERSIONS,
    EnvPolicy,
    GeneratedCalls,
    Host,
    HostAttachmentParams,
    HostBackgroundShouldRunParams,
    HostCapabilities,
    HostConfigGetParams,
    HostConfigGetResult,
    HostCoordinationAcquireParams,
    HostCoordinationReleaseParams,
    HostDiagnosticsLogParams,
    HostSecretParams,
    HostSecretsSetParams,
    InitializeParams,
    InitializeParamsHost,
    InitializeResult,
    Lease,
    NotFoundError,
    SecretValue,
    StreamCancelParams,
    Version,
    decode_call_error,
)
from ._subscription import END, Subscription

CALL_ERROR_CODE = -32000
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
CORE_METHODS = ("initialize", "stream/end", "stream/cancel")


class Client(GeneratedCalls):
    """One connection to an ARI driver. Methods such as `session_start_turn` are generated."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, host: Host | None = None, process: asyncio.subprocess.Process | None = None) -> None:
        self._reader = reader
        self._writer = writer
        self._host = host if host is not None else MemoryHost()
        self._process = process
        self._next_id = 1
        self._next_host_stream = 1
        self._pending: dict[int, tuple[asyncio.Future[Any], asyncio.Queue[Any] | None]] = {}
        self._streams: dict[str, asyncio.Queue[Any]] = {}
        self._refused: set[str] = set()
        self._closed: AriCallError | None = None
        self._write_lock = asyncio.Lock()
        self._tasks: set[asyncio.Task[None]] = set()
        self._reading = asyncio.get_running_loop().create_task(self._read_loop())

    @classmethod
    async def spawn(cls, program: str, *args: str, host: Host | None = None, env: dict[str, str] | None = None, cwd: str | None = None, stderr: Any = None) -> Client:
        """Starts `program args...` (an `ari-driver <driver>` invocation, such as the standalone
        executable) and connects to it over its stdin and stdout."""
        process = await asyncio.create_subprocess_exec(program, *args, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=stderr, env=env, cwd=cwd)
        assert process.stdout is not None and process.stdin is not None
        return cls(process.stdout, process.stdin, host, process)

    async def initialize(self, env_policy: EnvPolicy) -> InitializeResult:
        """The handshake. Offers every method of methods.json at its version and no process
        delegation: the driver spawns its agents itself, with `env_policy` applied. Methods whose
        major version differs, or that the driver does not list, are refused locally afterwards."""
        params = InitializeParams(
            ari_version=ARI_VERSION,
            grammar_versions=(1, 1),
            method_versions={name: Version(major=major, minor=minor) for name, (major, minor) in METHOD_VERSIONS.items()},
            persistence_version=Version(major=1, minor=0),
            host=InitializeParamsHost(capabilities=HostCapabilities(process=False), env_policy=env_policy),
        )
        result = InitializeResult.from_json(await self._call("initialize", params))
        if result.ari_version.split(".")[0] != ARI_VERSION.split(".")[0]:
            raise AriCallError(protocol("ari_version_mismatch", f"the driver speaks ARI {result.ari_version}, this client {ARI_VERSION}"))
        if result.grammar_version != 1:
            raise AriCallError(protocol("grammar_version_mismatch", f"the driver chose grammar version {result.grammar_version}, this client reads 1"))
        refused = set()
        for name, (major, _) in METHOD_VERSIONS.items():
            theirs = result.method_versions.get(name)
            if theirs is None or theirs.major != major:
                if name in CORE_METHODS:
                    raise AriCallError(protocol("core_method_missing", f"the driver does not speak {name} at major version {major}"))
                refused.add(name)
        self._refused = refused
        return result

    async def close(self) -> None:
        """Closes our side, waits up to ten seconds for `ari-driver` to exit, then kills it."""
        if not self._writer.is_closing():
            self._writer.close()
        if self._process is not None:
            try:
                await asyncio.wait_for(self._process.wait(), 10)
            except asyncio.TimeoutError:
                self._process.kill()
                await self._process.wait()
        await asyncio.gather(self._reading, return_exceptions=True)

    async def _call(self, method: str, params: Any) -> Any:
        return await self._request(method, params, None)

    async def _subscribe(self, method: str, params: Any, item_field: str, decode: Callable[[Any], Any]) -> Subscription[Any]:
        queue: asyncio.Queue[Any] = asyncio.Queue()
        started = await self._request(method, params, queue)
        stream_id = str(started["streamId"])

        async def cancel() -> None:
            await self._call("stream/cancel", StreamCancelParams(stream_id=stream_id))

        return Subscription(stream_id, queue, lambda params_: decode(params_.get(item_field)), cancel)

    async def _request(self, method: str, params: Any, stream: asyncio.Queue[Any] | None) -> Any:
        if self._closed is not None:
            raise self._closed
        if method in self._refused:
            raise AriCallError(unsupported(method, "the handshake refused this method"))
        request_id = self._next_id
        self._next_id += 1
        answer: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = (answer, stream)
        try:
            await self._write({"jsonrpc": "2.0", "id": request_id, "method": method, "params": encode(params)})
        except AriCallError:
            self._pending.pop(request_id, None)
            raise
        return await answer

    async def _write(self, frame: dict[str, Any]) -> None:
        data = (json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        async with self._write_lock:
            if self._writer.is_closing():
                raise AriCallError(transport("the connection is closed"))
            try:
                self._writer.write(data)
                await self._writer.drain()
            except (ConnectionError, RuntimeError) as error:
                raise AriCallError(transport(f"could not write to ari-driver: {error}")) from error

    async def _read_loop(self) -> None:
        buffer = bytearray()
        try:
            while chunk := await self._reader.read(1 << 16):
                buffer.extend(chunk)
                while (newline := buffer.find(b"\n")) != -1:
                    line = bytes(buffer[:newline]).strip()
                    del buffer[: newline + 1]
                    if not line:
                        continue
                    try:
                        frame = json.loads(line)
                    except ValueError:
                        continue  # the driver's mistake; the connection goes on
                    if isinstance(frame, dict):
                        self._handle(frame)
        except ConnectionError:
            pass
        self._close(AriCallError(transport("the ari-driver process closed its output")))

    def _handle(self, frame: dict[str, Any]) -> None:
        method = frame.get("method")
        params = frame.get("params", {})
        request_id = frame.get("id")
        if isinstance(method, str) and request_id is not None:
            task = asyncio.get_running_loop().create_task(self._answer(request_id, method, params))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
        elif isinstance(method, str):
            self._notification(method, params)
        elif isinstance(request_id, int):
            self._response(request_id, frame)

    def _response(self, request_id: int, frame: dict[str, Any]) -> None:
        entry = self._pending.pop(request_id, None)
        if entry is None:
            return
        answer, stream = entry
        if "error" in frame:
            if not answer.done():
                answer.set_exception(AriCallError(call_error_of(frame["error"])))
            return
        result = frame.get("result")
        if stream is not None and isinstance(result, dict) and isinstance(result.get("streamId"), str):
            self._streams[result["streamId"]] = stream
        if not answer.done():
            answer.set_result(result)

    def _notification(self, method: str, params: Any) -> None:
        stream_id = params.get("streamId") if isinstance(params, dict) else None
        if not isinstance(stream_id, str):
            return
        if method == "stream/end":
            queue = self._streams.pop(stream_id, None)
            if queue is not None:
                error = params.get("error")
                queue.put_nowait(END if error is None else AriCallError(decode_call_error(error)))
            return
        queue = self._streams.get(stream_id)
        if queue is not None:  # an item for a stream we do not know is dropped
            queue.put_nowait(params)

    async def _answer(self, request_id: Any, method: str, params: Any) -> None:
        watch = method == "host/config.get" and isinstance(params, dict) and params.get("watch") is True
        result: Any = None
        error: tuple[int, Any] | None = None
        if method == "stream/cancel":
            result = None  # this client starts no streams the driver could cancel: a config watch ends at once
        elif method not in HOST_METHODS:
            error = (METHOD_NOT_FOUND, unsupported(method, "no such host method"))
        else:
            name, decode = HOST_METHODS[method]
            try:
                result = encode(await getattr(self._host, name)(decode(params)))
            except AriCallError as failure:
                error = (CALL_ERROR_CODE, failure.error)
            except WireDecodeError as failure:
                error = (INVALID_PARAMS, validation(str(failure)))
            except Exception as failure:  # noqa: BLE001 - every host failure becomes an answer
                error = (INTERNAL_ERROR, protocol("uncaught_error", f"{type(failure).__name__}: {failure}"))
        ended_stream = None
        if error is None:
            if watch and isinstance(result, dict) and "streamId" not in result:
                # A host with nothing to watch still starts the stream and ends it at once.
                ended_stream = f"host-config-{self._next_host_stream}"
                self._next_host_stream += 1
                result["streamId"] = ended_stream
            frame = {"jsonrpc": "2.0", "id": request_id, "result": result}
        else:
            code, call_error = error
            frame = {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": str(AriCallError(call_error)), "data": encode(call_error)}}
        try:
            await self._write(frame)
            if ended_stream is not None:
                await self._write({"jsonrpc": "2.0", "method": "stream/end", "params": {"streamId": ended_stream}})
        except AriCallError:
            pass

    def _close(self, error: AriCallError) -> None:
        self._closed = error
        for answer, _ in self._pending.values():
            if not answer.done():
                answer.set_exception(error)
        self._pending.clear()
        for queue in self._streams.values():
            queue.put_nowait(error)
        self._streams.clear()


def call_error_of(error: Any) -> Any:
    """The call error in a JSON-RPC error: its `data` when that is one, else one made from the code."""
    message = str(error.get("message", "the driver refused the call")) if isinstance(error, dict) else "the driver refused the call"
    data = error.get("data") if isinstance(error, dict) else None
    if isinstance(data, dict) and isinstance(data.get("code"), str):
        try:
            return decode_call_error(data)
        except WireDecodeError:
            pass
    code = error.get("code") if isinstance(error, dict) else None
    if code == METHOD_NOT_FOUND:
        return unsupported("unknown", message)
    if code == INVALID_PARAMS:
        return validation(message)
    return protocol("jsonrpc_error", message)


class MemoryHost(Host):
    """A host that keeps everything in memory: each instance's config (`with_config`), secrets,
    coordination leases and the diagnostics the driver logs. Background work may always run; no
    attachments resolve. The other host services refuse with `unsupported`."""

    def __init__(self) -> None:
        self._configs: dict[str, Any] = {}
        self._secrets: dict[tuple[str, str, str], SecretValue] = {}
        self._leases: dict[str, tuple[str, datetime]] = {}
        self._next_lease = 1
        self.diagnostics: list[HostDiagnosticsLogParams] = []
        """Every diagnostic the driver logged, in order."""

    def with_config(self, instance_id: str, config: Any) -> MemoryHost:
        """The config `host/config.get` answers for `instance_id`, the id the host gives `driver/create`."""
        self._configs[instance_id] = config
        return self

    async def config_get(self, params: HostConfigGetParams) -> HostConfigGetResult:
        if params.instance_id not in self._configs:
            raise AriCallError(NotFoundError(message=f"no config for instance {params.instance_id}", resource="instance", id=params.instance_id))
        return HostConfigGetResult(config=self._configs[params.instance_id])

    async def secrets_get(self, params: HostSecretParams) -> SecretValue | None:
        return self._secrets.get((params.instance_id, params.namespace, params.key))

    async def secrets_set(self, params: HostSecretsSetParams) -> None:
        base64.b64decode(params.value.base64, validate=True)
        self._secrets[(params.instance_id, params.namespace, params.key)] = params.value

    async def secrets_delete(self, params: HostSecretParams) -> None:
        self._secrets.pop((params.instance_id, params.namespace, params.key), None)

    async def attachments_resolve(self, params: HostAttachmentParams) -> None:
        return None

    async def background_should_run(self, params: HostBackgroundShouldRunParams) -> bool:
        return True

    async def coordination_acquire(self, params: HostCoordinationAcquireParams) -> Lease | None:
        now = datetime.now(timezone.utc)
        if any(key == params.key and until > now for key, until in self._leases.values()):
            return None
        lease_id = f"lease-{self._next_lease}"
        self._next_lease += 1
        until = now + timedelta(milliseconds=max(params.ttl_ms, 1))
        self._leases[lease_id] = (params.key, until)
        return Lease(lease_id=lease_id, key=params.key, expires_at=until.isoformat(timespec="milliseconds").replace("+00:00", "Z"))

    async def coordination_release(self, params: HostCoordinationReleaseParams) -> None:
        self._leases.pop(params.lease_id, None)

    async def diagnostics_log(self, params: HostDiagnosticsLogParams) -> None:
        self.diagnostics.append(params)
