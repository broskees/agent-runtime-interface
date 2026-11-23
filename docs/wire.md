# `ari/wire`: ARI over stdio

`ari/wire` runs a driver in its own process and drives it over
newline-delimited JSON-RPC 2.0 on stdin and stdout. A host in any language
needs only three things to use it: this page, `spec/v1/methods.json` (every
method, its direction, params, result and version) and the JSON Schema in
`spec/v1/` (published as `ari/json-schema/*.json`).

The `ari-driver` program serves one driver. The TypeScript client in
`ari/wire` turns it back into a `Driver` whose instances and sessions behave
like in-process ones; the conformance suite passes through it with the same
results, event numbers and ids as in process.

## Running `ari-driver`

```sh
ari-driver pi                          # a first-party driver: ari/drivers/pi
ari-driver ./my-driver.js              # any module that exports a driver
ari-driver ./drivers.js --export mine  # a module with several drivers
```

- **By name.** `ari-driver <name>` loads `ari/drivers/<name>`. Names are
  lowercase letters, digits and hyphens. There is no registry: a driver is
  found because its directory exists.
- **By module path.** An argument with a `/` or `\`, a leading `.`, or a
  `.js`, `.mjs`, `.cjs`, `.ts`, `.mts` or `.cts` ending is a path, resolved
  against the working directory and loaded as a file, never as a package.
- **Which export.** `--export <name>` picks an export. Otherwise the default
  export is used if it is a driver, else the only export that is a driver,
  else (by name) the one whose `kind` is the name.
- **Stdout is the protocol.** Before the driver loads, `ari-driver` points
  `console` and `process.stdout.write` at stderr, so a driver that logs
  cannot corrupt a frame. Diagnostics go to stderr.
- **Lifetime.** It serves until stdin closes, or until SIGTERM or SIGINT, then
  disposes every instance (which closes their sessions and ends their child
  processes) and exits 0. Cleanup gets at most 10 seconds. A load failure
  prints the reason to stderr and exits 1; a usage error exits 2.

## Framing

Each frame is one JSON-RPC 2.0 object on one line, ending in `\n`. Batches
are refused (`-32600`). A line that is not JSON is answered with a `-32700`
error whose `id` is `null`, and the connection goes on.

Both sides send requests: the host calls the driver, and the driver calls
the host's services (`host/*`). Each side numbers its own request ids.

## The handshake

The host's first request is `initialize`. Anything else before it is refused
with `invalid_state` (`reason: "not_initialized"`); a second `initialize` with
`invalid_state` (`already_initialized`).

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "ariVersion":"1.0.0",
  "grammarVersions":[1,1],
  "methodVersions":{"session/startTurn":{"major":1,"minor":0}},
  "persistenceVersion":{"major":1,"minor":0},
  "host":{"capabilities":{"process":true},"envPolicy":{"stripAmbient":["GOOGLE_*"]}}}}
```

The result is the driver's own side of the same fields, the negotiated
`grammarVersion`, and the driver's non-method members (`kind`, `ariVersion`,
`metadata`, `configSchema`, `cliManifest`). Both ends then apply the same
rules, which `negotiateHandshake` implements:

| Axis | Rule |
|---|---|
| `ariVersion` | Same major version, or the connection is refused. |
| `grammarVersions` | Each side's ascending `[min, max]`. The connection uses the highest version both contain; ranges that do not overlap are refused, naming both ranges. |
| `methodVersions` | Per method. Same major: the lower minor is used, so a newer side never sends what an older side cannot read. Different majors: that method is refused (calls to it reject with `unsupported`, naming both versions) and the rest works. A method the host does not list is spoken at the driver's version. |
| `persistenceVersion` | Same major, or the connection is refused; the lower minor is used for stored handles and journals. |

A refusal is a `protocol` call error. `host.capabilities.process` and
`host.envPolicy` decide how the driver spawns processes (see below).

## Methods

`methods.json` lists every method. Its mapping rules:

- **Params** are the TypeScript arguments plus the target: `instanceId` for
  instance methods and host services, `sessionId` for session methods.
  Positional arguments become named fields: `readSnapshot(threadId)` is
  `{"sessionId":…,"threadId":…}`, `mcpApps.callTool(threadId, server, tool,
  args)` is `{…,"threadId","server","tool","args"}`.
- **Results** are the return value; `void` and `undefined` are `null`.
- **Bytes** travel as `{"base64": "…"}` (secrets) or base64 strings (process
  output and input).
- Every incoming request and notification is checked against its params
  schema. Invalid params are refused with `validation`, naming the path.

### Objects: instances and sessions

- `driver/create` takes `CreateInstanceInput` plus the instance's `paths`
  (its `HostServices.paths`) and `hostMembers`, the optional host services
  the host serves for it (`attachments.extractText`,
  `hostTools.callDynamicTool`, `telemetry.track`, `ids.derive`); the driver
  sees every optional host service not listed as absent. The result is an
  `InstanceDescriptor`: `instanceId`, `continuationKey`, `bindingKey`,
  `credentialBinding`, `textGenerationGuarantees`, `accountKey`, and
  `members`, the optional instance members it has (`auth.start`,
  `limits.current`, …).
- `instance/openSession` answers a `SessionDescriptor`: `sessionId`,
  `capabilities` and `members`, the optional session members it has
  (`forkThread`, `backgroundTasks.list`, …).
- A call to a member the target lacks is refused with `unsupported`: for a
  session member its `capability` is the member's capability path from
  `methods.json`, for an instance member the member's path.

## Errors

Every rejected call carries a `CallError` (the 11 codes of
`errors.schema.json`) in the JSON-RPC error's `data`:

| JSON-RPC code | When | `data` |
|---|---|---|
| `-32000` | the driver or host rejected the call | the call error it threw |
| `-32601` | an unknown method, or one not sent in this direction | `unsupported`, `capability` = the method |
| `-32602` | params invalid against the schema | `validation` with `issues` |
| `-32603` | the callee threw something that is not a call error | `protocol`, `detail: "uncaught_error"` |

When the connection itself fails (the process died, a write failed), every
pending call rejects with a `transport` call error.

## Streams

`session/events`, `instance/statusChanges`, `instance/usageHistory.scan` and
`host/config.get` with `watch: true` start streams.

1. The request's result carries a `streamId`.
2. Each item arrives as the method's notification (`ari/event`,
   `instance/statusChanged`, `instance/usageRecord`, `host/config.changed`),
   with `streamId` and the item. The producer sends them only **after** the
   response that carries the `streamId`.
3. `stream/end` ends it, with `error` when it failed.
4. The consumer may send `stream/cancel`; the producer answers `null`, then
   sends `stream/end`.

Even so, a consumer may read a stream's first notifications before its own
code has stored the `streamId` (the response and the notifications can sit in
one read buffer). Hold notifications for an unknown `streamId` until the
response is handled; the TypeScript client does.

`session/events` takes `fromSeq`: the driver replays from that `seq`, then
continues live.

## Host services

The driver calls the host's services as `host/<group>.<member>` requests
naming the instance: `host/secrets.get`, `host/coordination.acquire`, … All
17 operations of `HostServices` cross the wire. `host/diagnostics.log` and
`host/telemetry.track` are notifications. `host/config.get` with `watch: true`
returns `{ config, streamId }` and streams later values as
`host/config.changed`.

### Processes

- **Local (the default).** When `initialize` says `process: false`, the
  driver spawns child processes itself, inside `ari-driver`, from its own
  environment minus every `envPolicy.stripAmbient` entry (a name, or a prefix
  ending in `*`), plus the request's `env`. Executable lookups are local too,
  since that is where the spawn happens. The host implements nothing.
- **Delegated.** When the host says `process: true` (a remote or sandboxed
  host), `host/process.spawn` asks the host to start the child and answers
  `{ processId, pid? }`. The child's output comes as `host/process.output`
  (base64), and after its last output, its exit as `host/process.exit`; the
  driver ends the child's stdout and stderr there. The driver writes with
  `host/process.write`, closes stdin with `host/process.closeStdin` and kills
  with `host/process.kill`. `host/process.resolveExecutable` asks the host.
  When the connection closes, the host kills the children it started for the
  driver.

## Synchronous members

`Driver.defaultConfig`, `Instance.auth.methods`, `Instance.limits.accountKey`,
`Session.capabilities`, `Session.canRelease`, `Session.contextWindow` and
`Session.canReuseContextUsage` return values directly in TypeScript, and are
plain requests on the wire. A client in another language simply makes them
async. The TypeScript client cannot wait inside a synchronous call, so it
answers from what the driver last reported and keeps that fresh:

| Member | Served from |
|---|---|
| `defaultConfig()` | read once after `initialize` |
| `capabilities()` | the `SessionDescriptor`, then each newer `capabilities.updated` event read through `events()` |
| `canRelease()` | read when the session opens, again after each call, each event read and each read of `canRelease()` |
| `auth.methods()` | read when the instance is created and after each `auth` call |
| `limits.accountKey()` | the `InstanceDescriptor`, refreshed on each read |
| `contextWindow(model, cwd)`, `canReuseContextUsage(a, b)` | per arguments: the first read asks the driver and answers `undefined` (no window known) or `false` (no reuse); later reads answer what the driver said. With the capability declared off, they throw `unsupported` as the contract requires. |

`WireSession` adds `fetchCanRelease()`, `fetchCapabilities()`,
`fetchContextWindow(model, cwd)` and `fetchCanReuseContextUsage(a, b)`, which
ask the driver and return its answer, for hosts that need it at once.

## When the driver dies

If `ari-driver` exits or the connection fails, the TypeScript client:

- rejects every pending call, and every later one, with the `transport` call
  error, whose message says how the process ended and quotes its last stderr;
- ends every open `events()` stream with a `turn.terminal` for each turn that
  started and had not settled: status `failed`, failure class
  `transport_error`, `threadDisposition: "broken"`, numbered after the last
  event the client saw for the session;
- kills the child processes it started for the driver.

A client in another language should do the same, so a crash never leaves a
turn or a call hanging.

## TypeScript

```ts
import { startAriDriver } from "ari/wire";

// `host` is this instance's HostServices, for example from ari/node's createNodeHostServices.
const connection = await startAriDriver({ driver: "pi", envPolicy: { stripAmbient: ["ANTHROPIC_*"] } });
const instance = await connection.driver.create(host, { instanceId: "pi-1", config: connection.driver.defaultConfig(), environment: {} });
const session = await instance.openSession({});
for await (const event of session.events()) console.log(event.seq, event.body.type);
await connection.close();
```

- `startAriDriver(options)` spawns `ari-driver` (by default this package's
  bin under the current Node; `command` runs another, such as the standalone
  binary) and connects. `delegateProcesses: true` offers `host.process`.
- `connectDriver(transport, options)` does the same over any transport with
  an `input` byte stream and a `write(frame)`.
- `serveDriver(driver, transport, options)` is the driver side, as
  `ari-driver` uses it on its own stdio.
