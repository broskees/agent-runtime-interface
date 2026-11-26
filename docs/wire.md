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
- **Lifetime.** It serves until stdin closes, or until SIGTERM, SIGINT or
  SIGHUP, then disposes every instance (which closes their sessions) and ends
  its child processes, and exits 0. The child processes are ended no later
  than 1 second after the shutdown began, even while an instance's dispose
  still runs. Cleanup gets at most 10 seconds. A load failure prints the
  reason to stderr and exits 1; a usage error exits 2. If it dies without
  that cleanup, its agents still end: see
  [Agents end when `ari-driver` dies](#agents-end-when-ari-driver-dies).

## Framing

Each frame is one JSON-RPC 2.0 object on one line of UTF-8, ending in `\n`.
Split lines on `\n` only: JSON strings may hold raw U+2028 and U+2029. A `\r`
before the `\n` is dropped, blank lines are skipped, and a frame may be
megabytes long. Batches are refused (`-32600`). A line that is not JSON is
answered with a `-32700` error whose `id` is `null`, and the connection goes
on.

Both sides send requests: the host calls the driver, and the driver calls
the host's services (`host/*`). Each side numbers its own request ids; an id
is a string or a number. `params` is always an object of named fields.

- **Serve while you wait.** Keep reading and answering frames while your own
  calls are pending. A driver often calls `host/*` before it answers the
  host's request (a turn reads secrets and spawns processes), so a host that
  blocks until its own call returns deadlocks. Answers come in any order.
- **Notifications get no answer.** An unknown notification, one with invalid
  params, or one for a method the handshake refused is dropped, and so is a
  response whose id matches no pending call. `ari-driver` reports each on
  stderr.

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
| `methodVersions` | Per method. Same major: the lower minor is used, so a newer side never sends what an older side cannot read. Different majors: that method is refused (calls to it reject with `unsupported`, naming both versions) and the rest works. A method the host does not list is spoken at the driver's version; a method the driver does not list does not exist on the connection. |
| `persistenceVersion` | Same major, or the connection is refused; the lower minor is used for stored handles and journals. |

Two more rules keep a refused method from leaving a stream or a child
half-working:

- **Helpers.** Some methods work only with others: `session/events` needs
  `ari/event`, `instance/statusChanges` needs `instance/statusChanged`,
  `instance/usageHistory.scan` needs `instance/usageRecord`,
  `host/config.get` needs `host/config.changed`, and `host/process.spawn`
  needs `host/process.output`, `.exit`, `.write`, `.closeStdin` and `.kill`.
  When a helper is refused, or the driver does not list it, the method is
  refused too, and its `unsupported` error names the helper.
- **Core methods.** `initialize`, `stream/end` and `stream/cancel` carry every
  stream, so they are never refused alone. If the driver does not list one,
  or the two sides list one with different majors, the connection is
  refused. A driver lists every method it serves, these three included.

A refused connection is a `protocol` call error naming both sides' values.
Its `detail` names the rule: `ari_version_mismatch`,
`grammar_version_mismatch`, `persistence_version_mismatch`,
`core_method_missing` or `core_method_version_mismatch`. The driver is then
still uninitialized, and the host may send `initialize` again. The host runs
the same rules on the driver's answer, so both ends refuse the same methods.

`host.capabilities.process` and `host.envPolicy` decide how the driver spawns
processes (see below).

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
- **Instance ids.** `driver/create` takes the host's `instanceId`, and every
  `host/*` call for that instance names it by that id. The result's
  `instanceId` is the driver's id for the instance, which may differ;
  `instance/*` calls name the instance by that one.

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
- `instance/dispose` disposes the instance and closes its sessions; later
  calls naming any of them answer `not_found`.

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
`host/config.get` with `watch: true` start streams. The side that answers the
request produces the stream; the side that sent it consumes it.

1. The request's result carries a `streamId`, unique among the producer's
   streams on the connection.
2. Each item arrives as the method's notification (`ari/event`,
   `instance/statusChanged`, `instance/usageRecord`, `host/config.changed`),
   with `streamId` and the item. The producer sends them only **after** the
   response that carries the `streamId`.
3. `stream/end` (`{ streamId, error? }`) ends it; `error` is a `CallError`
   when the stream failed. Nothing follows it for that `streamId`.
4. The consumer may send `stream/cancel`, a request; the producer answers
   `null`, then sends `stream/end`. Cancelling a stream that already ended, or
   one the producer does not know, also answers `null`.

Even so, a consumer may read a stream's first notifications before its own
code has stored the `streamId` (the response and the notifications can sit in
one read buffer). Hold notifications for an unknown `streamId` until the
response is handled; the TypeScript client does.

`session/events` takes `fromSeq`: the driver replays from that `seq`, then
continues live.

`host/config.get` with `watch: true` always answers `{ config, streamId }`
(`HostConfigWatchResult`). A host with nothing to watch still starts the
stream and ends it at once. The driver refuses a watch answer without
`streamId` as a `protocol` error (`missing_stream_id`). Without `watch`, the
answer is `{ config }`.

## Host services

The driver calls the host's services as `host/<group>.<member>` JSON-RPC
requests whose params name the instance: `host/secrets.get`,
`host/coordination.acquire`, … All 17 operations of `HostServices` are
requests, and the host answers each one with its result (`null` for a `void`
member) or a call error.

- `host/diagnostics.log` and `host/telemetry.track` return nothing in
  TypeScript, so the driver does not wait for their answer. `ari-driver`
  writes an error answer to its stderr and goes on.
- The driver calls an optional service (`attachments.extractText`,
  `hostTools.callDynamicTool`, `telemetry.track`, `ids.derive`) only when
  `driver/create` listed it in `hostMembers`. A host answers one it does not
  serve with `unsupported`.
- A call naming an `instanceId` the host did not create answers `not_found`.

### Processes

- **Local (the default).** When `initialize` says `process: false`, the
  driver spawns child processes itself, inside `ari-driver`, from its own
  environment minus every `envPolicy.stripAmbient` entry (a name, or a prefix
  ending in `*`), plus the request's `env`. Executable lookups are local too,
  since that is where the spawn happens. The host implements nothing.
- **Delegated.** When the host says `process: true` (a remote or sandboxed
  host), the host starts the driver's children. `host/process.resolveExecutable`
  asks the host too.

In delegated mode:

1. `host/process.spawn` takes the `SpawnRequest` plus a `processId` the
   driver chose. The id is unique on the connection and never reused, even
   after its child exits. A host refuses an id it has seen before with
   `invalid_state` (`reason: "duplicate_process_id"`) and starts nothing. The
   answer is `{ pid? }`.
2. Only after that answer, the host sends the child's output as
   `host/process.output`: `{ processId, stream, data }`, where `stream` is
   `stdout` or `stderr` and `data` is standard base64 with padding.
3. After the child's last output, the host sends `host/process.exit`:
   `{ processId, exit: { code, signal } }`, both present, either `null`. The
   driver ends the child's stdout and stderr there.
4. The driver writes stdin with `host/process.write` (base64 `data`), closes
   it with `host/process.closeStdin`, and kills with `host/process.kill`.
   Without `signal`, the host ends the child its own way; the TypeScript host
   sends SIGTERM to the child's process group, then SIGKILL. These calls name
   the instance and the `processId`; a child that instance did not spawn
   answers `not_found`.
5. When the connection closes, the host kills the children it started for
   the driver. A spawn that was still in progress then is killed as soon as it
   resolves, and never registered.

The driver drops output or an exit for a `processId` that is not running,
and `ari-driver` reports it on stderr.

### Agents end when `ari-driver` dies

On Linux and macOS, every process `ari/node`'s process service starts ends,
with every process still in its process group, within about the kill grace
(2 seconds by default) plus a fraction of a second after the process that
owns the service ends, however it ends: dispose, SIGTERM, SIGINT, SIGHUP,
SIGKILL, a crash or an out-of-memory kill. That covers the agents
`ari-driver` spawns locally, and the children a TypeScript host using
`createNodeHostServices` spawns in delegated mode (there the host is the
owner).

What it does not reach: a process that has left the child's process group,
by calling `setsid()` or `setpgid()` (a daemon, `setsid sleep`, a job-control
shell's background jobs). It is no longer in the group, so neither the owner
nor the guard ends it. Windows keeps ending a child's tree with
`taskkill /T`, and only while the owner lives.

How:

- Each child leads its own process group. The process service spawns it
  through a `/bin/sh` launcher, which first starts the child's guard in the
  background, in that same group, and then `exec`s the child in its own
  place. The child keeps the pid the caller sees, and never runs before its
  guard exists.
- The guard is a `/bin/sh` with stdio on `/dev/null`, holding only the read
  end of a pipe whose other end the owner holds; the pipe is passed at spawn,
  so an owner that dies before the guard starts leaves it an immediate
  end-of-file. It ignores SIGTERM, SIGHUP and SIGINT (and SIGQUIT, SIGPIPE,
  SIGALRM, SIGUSR1, SIGUSR2), so a driver's own signal to the group reaches
  the child but not the guard.
- When the owner dies, or the owner writes a line to the pipe, the guard
  sends SIGTERM to its own group, waits until no member but itself is left or
  the grace has passed (it reads membership with `ps -A -o pid= -o ppid=
  -o pgid=` and `awk`, at 20, 60, 140, 300 and 620 ms and then every 400 ms),
  sends SIGKILL to the group, itself included, and exits.
- The guard only ever signals the group it is a member of (`kill 0`). While a
  member exists, the operating system does not give that group id to anyone
  else, so the guard cannot reach a group ARI did not start. The owner signals
  the group by its id only while the guard still runs.
- The owner ends a group the same way, on dispose, a timeout, `kill()`
  without a signal, and when a child exits on its own (for what it left in
  its group): it writes a line to the guard's pipe and waits for the guard to
  exit. So `dispose()` returns only once every guard is gone, and waits a
  whole grace only for a group that will not end on SIGTERM.
- `ps` shows a guard as `/bin/sh -c … ari-agent-guard <grace ms> …`. It costs
  one idle shell per child: on Linux with bash as `/bin/sh`, about 4.2 MB
  resident, 0.4 MB of it not shared. Spawning takes about the same time as
  before under Node and about 1 ms more under Bun. Disposing 20 children
  took 140 to 190 ms instead of 22 ms, measured at a load average near 48.
- If the launcher cannot start the guard, the child never runs: it exits with
  code 126. If a guard disappears while its child runs, the owner ends the
  child's group at once.

What a caller sees stays as it was, with these exceptions. A spawn error
rejects as before, because the command is first searched for the way spawn
searches and a command that is not found is handed to spawn itself for the
platform's own error. The child's argv is the one spawn would give it, except
that with no `PATH` in the child's environment a bare command name runs by
its full path (that path is argv[0]), and that for its first few
milliseconds the pid shows the launcher's command line, until the launcher
`exec`s the child. `PWD` and `OLDPWD` are put back as the
child's environment had them, but with bash as `/bin/sh` an environment
without `SHLVL` gains `SHLVL=0`. An executable file that is not a program
(no `#!` line) is run by `/bin/sh` instead of failing with ENOEXEC.

A host in another language that runs `ari-driver` gets this for free: it only
has to end `ari-driver` (closing its stdin lets it dispose cleanly). A host
that runs the children itself in delegated mode owns their cleanup.

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
