# The ARI conformance kit

`ari/conformance` checks that a driver behaves the way the ARI contract says,
under the failure modes production hosts have hit: turns settled by quiet
timers, steers that start untracked turns, sessions swapped without notice,
probes with side effects, and so on. It runs 15 scenarios against your driver
and returns a report with one result per scenario.

The kit is browser-safe: nothing in `ari/conformance` imports a Node built-in
or a test runner. It runs under `node:test` through an adapter, and under any
other runner through `runConformance`.

## How it works

The kit drives your driver through ordinary ARI calls (`driver.create`,
`instance.openSession`, `session.startTurn`, ...) and reads its event stream.
On the other side of your driver sits a **fake native agent** that you write
once, beside your driver, speaking the vendor's real protocol. The kit moves
that fake step by step, like a puppet: "the agent receives a prompt", "the
agent streams this text", "the agent runs a tool", "the agent completes the
turn", "the agent's process exits". Your harness translates each neutral step
into the vendor's frames.

So the kit owns **time and order**, and your harness owns **the native
protocol**. The kit never learns whether your fake is a child process on
stdio, an HTTP server on a loopback port, or a fake SDK object handed to your
driver. All three plug in the same way (see [three shapes of
harness](#three-shapes-of-harness)).

## Running it

With `node:test`, one test per harness with one subtest per scenario:

```ts
import test from "node:test";
import { conformanceTests } from "ari/conformance";
import { myHarness } from "./harness.ts";

conformanceTests(test, myHarness);
```

The adapter takes `node:test`'s `test` function as an argument rather than
importing `node:test`, which keeps `ari/conformance` loadable in a browser.
A failed scenario fails its subtest with the reason; a scenario that does not
apply is skipped with its reason; notes become test diagnostics. Pass
`{ onReport }` to receive the whole report, for example to save fixtures.

With any other runner:

```ts
import { formatReport, runConformance } from "ari/conformance";

const report = await runConformance(myHarness, { timeoutMs: 10_000 });
console.log(formatReport(report));
if (!report.passed) process.exitCode = 1;
```

`runConformance` options: `scenarios` (numbers or keys, to run a subset) and
`timeoutMs` (the longest real-time wait for any one step; default 10000).
The grammar scenario (1) always runs last, because it judges the streams of
every other scenario in the run.

The in-memory reference driver ships with the kit, so you can try it now:

```ts
import { referenceHarness, runConformance } from "ari/conformance";

const report = await runConformance(referenceHarness());
```

## Plugging a driver in

You implement `ConformanceHarness`:

```ts
interface ConformanceHarness<Config> {
  name: string;
  notApplicable?: { [key: string]: string };   // one-line reasons, see "Applicability"
  time?: "virtual" | "real";                   // default "virtual", see "Time"
  workspace(): Promise<ConformanceWorkspace>;  // called once per run
  setup(request: RigRequest): Promise<HarnessRig<Config>>; // called once per rig
}
```

A **rig** is a fresh native side: a new fake agent with a new, empty native
store. Native ids start over in every rig, so two rigs that do the same things
produce the same native ids. Scenario 11 depends on that to compare a run in
the real workspace with a run through a symbolic link. Every rig of one run
uses the workspace `workspace()` returned.

```ts
interface ConformanceWorkspace {
  cwd: string;           // a directory, as its canonical real path
  symlinkedCwd?: string; // the same directory reached through a symbolic link (scenario 11)
  otherCwd?: string;     // a second directory (forks into another directory)
}

interface RigRequest {
  scenario: string;                // the scenario key the rig is for
  workspace: ConformanceWorkspace;
  ambientAuth: "authenticated" | "unauthenticated" | "unknown" | "unavailable";
}
```

`ambientAuth` says how your fake answers a sign-in check for the ambient
account (the user's own provider login): signed in, signed out, cannot tell,
or cannot answer at all (a failed or timed-out check). Only the auth scenario
asks for anything other than `authenticated`.

`setup` returns the rig:

```ts
interface HarnessRig<Config> {
  driver: Driver<Config>;     // your driver, wired to this rig's fake
  config?: Config;            // defaults to driver.defaultConfig()
  hostOptions?(instanceId: string, arrangement: { managedProfile: boolean }): FakeHostOptions<Config>;
  native: NativeAgent;        // the puppet
  probeExecutables?: string[];      // what probe() may spawn; default: cliManifest.binary
  inheritedCredentials?: string[];  // your provider's credential variables, e.g. ["ANTHROPIC_API_KEY"]
  listInstanceFiles?(paths: HostPaths): Promise<InstanceFile[]>;
  exercise?: CapabilityExercise;    // inputs for members the kit cannot invent
  missingSession?: NativeRef | { handle: string };
  dispose?(): Promise<void>;
}
```

- `hostOptions` configures the fake host of one instance (see [the fake
  host](#the-fake-host)): its `paths`, how it spawns or resolves
  executables, and its secrets. When `arrangement.managedProfile` is true,
  give the instance its own stored but never-checked credential (for example
  an API key in its secrets), so its auth state is `configured`.
- `listInstanceFiles` lists every file under an instance's paths with its
  size and modification time; the probe scenario compares the list before and
  after `probe()`. `test/helpers/conformance.ts` has a Node implementation.
- `exercise` gives the kit an MCP app your fake serves
  (`{ server, tool, args, resourceUri }`), one harmless call per extension
  namespace your driver lists (`{ [ns]: { method, params } }`), and a model id.

### The puppet

```ts
interface NativeAgent {
  nextTurn(): Promise<NativeTurn>;           // the next prompt your driver sent
  lockSession?(thread: Thread): Promise<void>;
  observedEnvironments?(): Promise<Array<{ [name: string]: string }>>;
}

interface NativeTurn {
  readonly prompt: string;
  say(text: string): Promise<void>;          // stream text (in chunks if the protocol streams), end the message
  runTool(tool: NativeTool): Promise<void>;  // the tool's call, then its result
  requestApproval(approval: NativeApproval): Promise<NativeApprovalHandle>;
  startBackgroundTask?(task: { title: string }): Promise<void>;
  spawnSubagent?(subagent: { name: string }): Promise<void>;
  nextSteer?(): Promise<string>;             // the text of the next steer for this turn
  complete(): Promise<void>;                 // the provider's authoritative completion
  fail(failure: NativeFailure): Promise<void>;
  stopRequested(): Promise<"cancel" | "exit">;
  finishCancelled(): Promise<void>;
  exitProcess(): Promise<void>;
}
```

Rules every harness keeps:

- **A step resolves once the native side has done it**, meaning the frames are
  sent. It never waits for your driver to react; the kit waits for that on
  the ARI side.
- **The fake does nothing on its own.** A turn stays open until the kit calls
  `complete`, `fail`, `finishCancelled` or `exitProcess`. No timers.
- **Option ids are native ids.** `requestApproval` options carry an
  `optionId` and an ARI `decision` (`accept`, `accept_for_session`,
  `accept_always`, `decline`). Map the decision to your protocol's option kind
  and keep `optionId` as the native option id. The handle's `replies()` lists
  every native option id the fake received for that approval, in order.
- **`runTool`'s `path` is workspace-relative.** Report it the way the vendor
  does, normally as an absolute path in the agent's own (canonical) working
  directory.
- **`fail`** takes `{ kind: "provider_error", message }` or
  `{ kind: "usage_limit", message, resetAt }`. Report each the way the
  provider reports it.
- **`stopRequested`** resolves with `"cancel"` when your driver asked the
  agent to stop the turn, or `"exit"` when it ended the agent's process to
  stop it.
- **`lockSession`** makes resuming that native session fail the way the
  provider fails a session held by another process.
- **`observedEnvironments`** is for drivers that do not spawn through the
  host, such as an in-process SDK given an `env` option: return the
  environments the native runtime was started with. Spawns through the host
  are checked from the fake host's record.

Optional puppet members are needed only when your driver declares the
matching capability: `startBackgroundTask` for `background.*`,
`spawnSubagent` for `subagents.stop`, `nextSteer` for `turns.steer`. Without
them, the scenario fails unless you give a reason (see
[Applicability](#applicability)).

## Three shapes of harness

### A child process on stdio (Pi, ACP, Codex, Muse)

Your driver spawns the vendor CLI through `host.process.spawn`. The fake host
hands that request to your `spawn`, which starts your fake agent instead. Two
ways work:

1. **A real child process.** Start your fake agent's script with
   `child_process.spawn`, with stdio piped plus an IPC channel your driver
   never sees. Protocol frames go over stdin and stdout; puppet calls go over
   IPC. This is how `test/conformance/child-process-harness.ts` runs the
   reference agent, and it is the most faithful: real pipes, real exit codes,
   real files.
2. **In memory.** Return a `SpawnedProcess` made of queues
   (`createMemoryProcess` from `ari/conformance`) wired to a fake agent object
   in the same process. Faster, and works in a browser.

```ts
import * as childProcess from "node:child_process";
import { toSpawnedProcess, instanceDirectories, listInstanceFiles, createConformanceWorkspace } from "../helpers/conformance.ts";

export function piHarness(): ConformanceHarness<PiConfig> {
  const { workspace, root } = createConformanceWorkspace();
  return {
    name: "pi",
    workspace: async () => workspace,
    async setup(request) {
      const turns = new AsyncTurnQueue();          // your queue of NativeTurn
      const spawn = async (spawn: FakeSpawnRequest) => {
        const child = childProcess.spawn(process.execPath, [FAKE_PI, ...(spawn.args ?? [])], {
          env: { ...spawn.environment },             // exactly what the host computed
          cwd: spawn.cwd,
          stdio: ["pipe", "pipe", "pipe", "ipc"],
        });
        child.on("message", (message) => turns.onChildMessage(child, message)); // "a prompt arrived" -> NativeTurn
        return toSpawnedProcess(child);
      };
      return {
        driver: piDriver,
        hostOptions: (instanceId) => ({
          paths: instanceDirectories(root, instanceId),
          spawn,
          resolveExecutable: async (name) => (name === "pi" ? FAKE_PI : null),
        }),
        native: { nextTurn: () => turns.next() },
        listInstanceFiles,
        inheritedCredentials: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
      };
    },
  };
}
```

Pass the child exactly `spawn.environment`: it is the host's ambient
environment minus `envPolicy.stripAmbient`, plus your driver's own
additions. Adding the test's `process.env` would defeat the
inherited-credentials check.

### An HTTP server (OpenCode)

Your fake is an HTTP server in the test process, listening on port 0 so
parallel test files never collide. The puppet drives it directly, because it
lives in the same process; for example `say` pushes server-sent events to
the connected client. How your driver reaches the server depends on the
driver:

- **The driver spawns the server** (`opencode serve`): your `spawn` starts the
  fake server, then returns a `SpawnedProcess` (from `createMemoryProcess`)
  whose stdout prints the listening line the real server prints, and whose
  `kill` closes the server. `exitProcess` closes the server and exits the
  fake process.
- **The driver connects to an external server**: put the fake server's URL in
  the rig's `config`.

```ts
async setup(request) {
  const server = await startFakeOpencodeServer({ ambientAuth: request.ambientAuth }); // port 0
  return {
    driver: opencodeDriver,
    config: { ...opencodeDriver.defaultConfig(), serverUrl: server.url },
    native: { nextTurn: () => server.nextPrompt() },  // NativeTurn whose steps write SSE events
    hostOptions: (instanceId) => ({ paths: instanceDirectories(root, instanceId) }),
    listInstanceFiles,
    dispose: () => server.close(),
  };
}
```

### An in-process SDK (Claude, Cursor)

Your driver loads the vendor SDK with a dynamic `import()`. Give the driver a
way to receive a fake SDK object instead, for example a factory option
(`createClaudeDriver({ loadSdk })`), and build the driver inside `setup` with
the fake. The fake SDK's methods (a `query()` that yields messages, an agent
that emits events) are driven by the puppet. "Process exit" is however the
SDK reports its runtime dying: an error from the stream, or the bundled CLI's
exit. Record the `env` option the driver passed to the SDK and return it from
`observedEnvironments`.

```ts
async setup(request) {
  const sdk = createFakeClaudeSdk({ ambientAuth: request.ambientAuth }); // typed against the pinned SDK
  return {
    driver: createClaudeDriver({ loadSdk: async () => sdk }),
    native: { nextTurn: () => sdk.nextQuery(), observedEnvironments: async () => sdk.environments() },
    hostOptions: (instanceId) => ({ paths: instanceDirectories(root, instanceId) }),
    listInstanceFiles,
    inheritedCredentials: ["ANTHROPIC_API_KEY"],
  };
}
```

### A driver behind `ari/wire`

`rig.driver` can be any object that implements `Driver`, including a wire
client for a driver running in another process. When the host serves
`host.process`, the driver's spawns come back to the test process and reach
your `spawn` as usual. Set `time: "real"` for such a harness (see
[Time](#time)).

## The fake host

`createFakeHost(options)` builds a complete in-memory `HostServices` and
records every host-service call. The kit makes one per instance from your
`hostOptions`; driver tests can use it directly too.

- `calls` holds every call as `{ index, operation, args }`, where
  `operation` is one of the 17 names in `HOST_OPERATIONS` (`config.get`,
  `secrets.get`, `secrets.set`, `secrets.delete`, `process.spawn`,
  `process.resolveExecutable`, `attachments.resolve`,
  `attachments.extractText`, `callbacks.register`, `hostTools.mcpServerFor`,
  `hostTools.callDynamicTool`, `background.shouldRun`,
  `coordination.acquire`, `coordination.release`, `diagnostics.log`,
  `telemetry.track`, `ids.derive`). `mark()` and `callsSince(mark)` slice it.
- `spawns` holds every spawn with the environment the child got.
- **The environment rule.** A spawned child gets `ambientEnvironment` minus
  each `envPolicy.stripAmbient` entry (a name, or a prefix ending in `*`),
  plus the request's own `env`. Without an explicit `envPolicy`, the host
  strips the prefixes your driver's CLI manifest declares
  (`cliManifest.envScrubPrefixes`), as a host that honours the manifest does.
- Secrets refuse a namespace or key that is empty or contains `..` or `/`,
  and return copies of the stored bytes.
- Coordination leases are exclusive until released or until `ttlMs` passes
  on `Date.now()` (so virtual time expires them).
- `spawn` and `resolveExecutable` come from you; without them every spawn
  rejects with `not_found` and every lookup returns `null`.

## Time

Two scenarios need long pauses: settlement puts 36.5 seconds between a tool
result and the completion, and the auth scenario waits for a runtime auth
poison to expire (30 seconds for the reference driver).

With `time: "virtual"` (the default), the kit installs a `VirtualClock` for
those stretches. It replaces this realm's `setTimeout`, `clearTimeout`,
`setInterval`, `clearInterval`, `Date` (`new Date()` and `Date.now()`) and
`performance.now()`. Time stands still until the kit moves it, in 250 ms
steps with real I/O between them. A driver that settles a turn from an
ordinary quiet timer, either a `setTimeout` re-armed on every frame or a
`setInterval` comparing `Date.now()` against the last frame, sees its timer
fire at the 30-second mark and is caught, while the test takes well under a
second. The kit's own deadlines keep real time.

Virtual time does not reach `setImmediate`, `queueMicrotask`,
`process.nextTick` (all stay real, so I/O and promises keep running), timers
taken from `node:timers` or `node:timers/promises` directly,
`AbortSignal.timeout`, or anything in another process. If your driver runs in
another process (behind `ari/wire`) or keeps its timers that way, set
`time: "real"`: the scenarios then wait the full 36.5 seconds.

## The scenarios

| # | Key | The kit checks | The harness provides | Not applicable when |
|---|---|---|---|---|
| 1 | `grammar` | Every session stream of the run, read from `seq` 1, keeps the `ari/host` EventGrammar in strict mode. Its own stream adds a rich turn (text, a tool, an approval if available) and a stopped turn. | - | never |
| 2 | `turn-completed` | The turn stays open after its assistant message ends; after the provider completes it, `turn.terminal` is `completed` and `reusable`, the turn's assistant text is what the agent said, and no item is left open. | `say`, `complete` | never |
| 3 | `turn-interrupted` | `interruptTurn` reaches the agent; `turn.terminal` is `interrupted`; nothing left open. | `stopRequested`, `finishCancelled` | never |
| 4 | `turn-failed` | A provider error ends `failed` with failure class `provider_error`; a usage limit ends `failed` with class `usage_limit` and the provider's `resetAt`. | `fail` | check `turn-failed.usage_limit` |
| 5 | `process-exit` | The agent's process dying mid-turn ends the turn `failed` with a valid failure. | `exitProcess` | never |
| 6 | `settlement` | Nothing settles the turn (no `turn.terminal`, no `turn.upsert` with a settled status) from its start, through the tool result and a 36.5 s pause after it, until the provider completes it; then it completes. | `runTool`, `complete` | never |
| 7 | `steer-after-end` | A steer after the turn ended, and one that races the provider's completion, return `prompt_required`; the provider never sees them as turns. | `complete` | `turns.steer` off |
| 8 | `duplicate-always-options` | An approval with two `accept_always` options and a decline is an approval kind (not `user_input`), with no questions, keeping each native option id and an accepting or declining decision; replying reaches the agent. | `requestApproval` | `approvals.command` and `approvals.fileChange` off, `requests.responseModes` without `live`, or no supervised runtime mode |
| 9 | `session-replaced` | Resuming an available session keeps its thread and replaces nothing. Resuming a locked session, then a missing one, falls back to a fresh session and emits `session.replaced` with `contextLost: true`. | `lockSession` | check `session-replaced.locked` |
| 10 | `auth-states` | A stored unchecked credential is `configured` and Send works, even with the ambient account signed out; an unanswerable check is `unavailable` and Send works; an undecidable one is `unknown`; `reportRuntimeFailure` poisons only its own scope (`runtime_poison`, `unauthenticated`, a short `poisonExpiresAt`) and expires; inherited credentials never reach the agent. | `ambientAuth` arrangements, `managedProfile` secrets, `inheritedCredentials` | `Instance.auth` left out; checks `auth-states.configured`, `.unavailable`, `.unknown`, `.poison`, `.inherited-credentials` |
| 11 | `symlinked-workspace` | A thread created through the symbolic link has the same id and cwd, and every event the same ids and paths, as one created through the real path. | `workspace().symlinkedCwd` | `symlinked-workspace` |
| 12 | `side-effect-free-probe` | `probe()` and `probe({ deep: true })` return valid results, call no `secrets.set`, `secrets.delete`, `callbacks.register`, `coordination.acquire` or `hostTools.*`, spawn only the probe executables, and change no file under the instance's paths. | `listInstanceFiles`, `probeExecutables` | check `side-effect-free-probe.files` |
| 13 | `replay-from-seq` | `events({ fromSeq: 1 })` and `events({ fromSeq: middle })` replay exactly the live events (same `seq`, same ids, same bodies), and the replayed stream goes on live identically. | `say`, `runTool`, `complete` | never |
| 14 | `capability-honesty` | Every capability-gated member the driver declares off is left out or rejects with `unsupported{capability}`; every one it declares on works and returns a valid result. See below. | the optional puppet members and `exercise` its declarations need | checks `capability-honesty.<member>` |
| 15 | `idempotent-responses` | Three responses with one `(requestId, responseKey)`, two of them concurrent, have one outcome and reach the agent once. Under `full_access`, the reply the agent gets is the narrowest accepting option, whether the driver answers itself or hands the request to the host's `fullAccessAutoReply`. | `requestApproval` | as scenario 8; the `full_access` part is skipped with a note when `runtimePolicy.modes.full_access` is off |

Scenario 14 checks these members, with the capability paths that gate them
(`GATED_MEMBERS` holds the table, and a test keeps it in step with
`spec/v1/methods.json`): `readSnapshot`, `forkThread` (and its `fromTurn`,
`fromItem` and `crossCwd` variants), `rollbackThread` (both
`threads.rollback` and `checkpointing.conversationRollback`),
`compactThread`, `injectHistory`, `unloadThread`, `release` (and a turn
after it), `backgroundTasks.list/stop/await`, `stopSubagent`,
`mcpApps.listTools/callTool/readResource`, `uploadFeedback`, `ext` (each
declared namespace works; an undeclared one is `unsupported`),
`contextWindow`, `canReuseContextUsage`, and the `steer` and `queue` intents
of `startTurn` (which may answer `{ status: "unsupported", capability }`).
It calls your driver's own session, without `ari/host`'s guard, because the
driver itself must be honest.

## Applicability

A scenario reports "not applicable" in exactly two cases, and the report
always shows why:

1. **A declared capability rules it out.** The driver declares the
   capability off, or leaves out the optional member (which is how a driver
   declares it lacks a feature). The reason names the capability or member:
   "the driver declares capability turns.steer off".
2. **The harness gives a one-line reason** under the scenario's key in
   `notApplicable`. The reason must be one non-empty line; anything else
   fails the scenario.

The same rule covers checks inside a scenario. A check the harness cannot
support (a missing `lockSession`, no `listInstanceFiles`, an auth state it
cannot arrange) fails the scenario unless `notApplicable` has a reason under
the check's key, such as `session-replaced.locked`. A skipped check becomes a
note in the result. Nothing else makes a scenario skip: a fake that lacks a
step the scenario needs is a failure.

## The report

`runConformance` returns `{ harness, results, passed }`. Each result has
the scenario's `id` (1 to 15), `key`, `title`, `status` (`passed`,
`failed` or `not_applicable`), `reason` (why it failed or does not apply),
`notApplicableBy` (`capability` or `harness`), `notes`, `durationMs`, and
`fixtures`: one replay fixture per session the scenario opened.

## Fixtures

Every session the kit opens is recorded with `ari/host`'s `ReplayRecorder`,
so each result carries its sessions as fixtures in the format of
`spec/v1/fixture.schema.json` (published as
`ari/json-schema/fixture.schema.json`). Save them to debug a failure, or
compare two runs of the same driver, for example in process and over
`ari/wire`.

A fixture is one JSON object:

```json
{
  "format": "ari.fixture",
  "persistence": { "major": 1, "minor": 0 },
  "ariVersion": "1.0.0",
  "grammarVersion": 1,
  "name": "turn-completed: session_...",
  "description": "Recorded by the ARI conformance kit (reference driver (full, in memory)).",
  "recordedAt": "2026-11-23T12:00:00.000Z",
  "driver": { "kind": "reference", "identityVersion": 1 },
  "sessionId": "session_...",
  "capabilities": { "ariVersion": "1.0.0", "sessions": { "...": "..." } },
  "entries": [
    { "type": "call", "callId": 1, "method": "session/createThread", "params": { "cwd": "/w", "policy": { "...": "..." } }, "at": "..." },
    { "type": "event", "event": { "seq": 1, "at": "...", "sessionId": "session_...", "body": { "type": "thread.upsert", "thread": { "...": "..." } } } },
    { "type": "result", "callId": 1, "result": { "id": "thread_...", "...": "..." }, "at": "..." },
    { "type": "error", "callId": 2, "message": "Not supported: turns.queue", "callError": { "code": "unsupported", "capability": "turns.queue", "message": "..." }, "at": "..." }
  ]
}
```

- `entries` is the recording in the order things happened. A `call` names
  the wire method from `methods.json` (`session/<member>`, for example
  `session/backgroundTasks.list`) with the wire params minus `sessionId`;
  positional arguments become named fields (`readSnapshot(threadId)` is
  `{ "threadId": ... }`). Its outcome is a `result` (`null` for nothing) or
  an `error` with the `message` and, for an ARI call error, the `callError`.
  Each event appears once, by `seq`, as an `event` entry; `events()` itself
  is not a call.
- `persistence` versions the format independently of the package and the
  wire. **A reader refuses a fixture whose persistence major version is newer
  than its own**: `loadFixture` throws a `validation` call error naming both
  versions, for example "Fixture persistence version 2.3 is newer than the
  supported persistence version 1.0". A newer minor version of the same major
  is read. `SUPPORTED_FIXTURE_PERSISTENCE` is the version this kit reads.
- `checkFixture(textOrObject)` loads a fixture, runs its events through the
  strict EventGrammar, and checks that every call has exactly one outcome.
  Use it on fixtures recorded elsewhere, for example from a real provider
  session.

## The reference driver

`referenceDriver` and `referenceHarness()` ship with the kit. The reference
driver is a complete stdio driver for a small agent protocol (newline-delimited
JSON-RPC 2.0, described at the top of `src/conformance/reference/protocol.ts`).
It shows the patterns the scenarios check: ids derived from native ids only,
settlement only on the agent's `turn_ended` or on process exit, `prompt_required`
for a late steer, native option ids with their real reach, `session.replaced`
on a locked or missing session, five auth states with a 30-second runtime
poison per scope, a probe that only runs `--version`, and `unsupported` for
everything declared off.

Its config: `profile` is `"full"` (every optional feature declared and
implemented) or `"minimal"` (all declared off, and no `auth`);
`fullAccessReplies` says whether the driver answers native approvals under
`full_access` itself, with the narrowest accepting option, or hands them to
the host.

`referenceHarness()` runs it against the reference agent in memory, with a
virtual workspace and filesystem, so it works in a browser.
`test/conformance/child-process-harness.ts` runs the same driver against the
same agent as a real child process, with real files and a real symbolic link.
Both pass all 15 scenarios.

## How the kit proves itself

`test/conformance/broken-drivers.ts` holds a deliberately broken variant of the
reference driver for each scenario: a delta before its item opens, completion
reported as interrupt, a turn settled when its message ends, Stop that never
reaches the agent, a usage limit classified as a provider error, a turn left
open when the process dies, a 30-second quiet timer, a turn settled by a tool
result, a late steer that starts a turn, duplicate `always`
options turned into a question, a silent session swap, a configured
credential treated as signed out, inherited credentials passed to the agent,
the workspace path reported as given, a probe that writes secrets or session
files, a replay that renumbers `seq`, a capability declared off but served (and
one declared on but refused), responses that are not idempotent, and an
`always` option mislabelled as reaching once. `test/conformance/broken.test.ts`
asserts each fails its scenario for that reason. Write your own the same way
when you add a check: a wrapper around an honest driver that adds one bug.
