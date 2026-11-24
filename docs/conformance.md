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

Under `bun test`, the same call works. Bun 1.3's `node:test` cannot run a
test inside another test: `context.test()` throws an error with code
`ERR_NOT_IMPLEMENTED`, and so does `context.skip()`. The adapter then runs
every scenario in the harness's own test: each scenario's notes and
not-applicable reason become diagnostics, and the test fails at the end with
the reason of every failed scenario. Run each test file in its own `bun test`
process, as this repository's `pnpm run test:bun` does: several files in one
Bun process can share state between them.

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
  otherCwd?: string;     // a second directory, as its canonical real path (forks into another directory)
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
  watchInstanceFiles?(paths: HostPaths): Promise<InstanceFileWatch>; // { stop(): Promise<string[]> }
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
- `watchInstanceFiles` starts watching every file under an instance's paths
  (`stateDir`, `cacheDir`, `tmpDir`); its `stop()` returns every path that was
  created, changed, renamed or removed meanwhile, including a file written and
  deleted again. The probe scenario watches for the whole of both `probe()`
  calls. `test/helpers/conformance.ts` has a Node implementation; see [what
  the probe's file check can see](#what-the-probe-file-check-can-see).
- `exercise` gives the kit an MCP app your fake serves
  (`{ server, tool, args, resourceUri }`), one harmless call per extension
  namespace your driver lists (`{ [ns]: { method, params } }`), and a model id.

### The puppet

```ts
interface NativeAgent {
  nextTurn(): Promise<NativeTurn>;           // the next prompt your driver sent
  lockSession?(thread: Thread): Promise<void>;
  observedEnvironments?(): Promise<Array<{ [name: string]: string }>>;
  inspectSession?(thread: Thread): Promise<NativeSessionState | undefined>;
  activity?(): Promise<NativeActivity>;
}

interface NativeSessionState {
  loaded: boolean;              // a running native agent has it loaded (not only stored)
  cwd: string;                  // its working directory, as the agent resolved it
  prompts: string[];            // the prompt of each turn it holds, oldest first: its history
  compactions: number;          // how many times it was compacted
  injectedMessages: string[];   // the text of each history message injected into it
  backgroundTasks: Array<{ title: string; running: boolean }>;
  subagents: Array<{ name: string; running: boolean }>;
}

interface NativeActivity {      // everything since the rig started, oldest first, in ARI's shapes
  feedback: Array<{ feedbackId: string; reason?: string }>;
  mcp: Array<
    | { operation: "listTools"; server: string; output: McpTool[] }
    | { operation: "callTool"; server: string; tool: string; args: unknown; output: McpCallResult }
    | { operation: "readResource"; server: string; uri: string; output: McpResourceContents }
  >;
  extensions: Array<{ params: unknown; result: unknown }>;
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
  completeHeld?(): Promise<{ release(): Promise<void> }>; // complete natively, tell the driver only on release()
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
  every option id the fake received for that approval, in order, as the kit
  named them. When the protocol's options have no id of their own (Codex
  app-server approvals offer decision values such as `"accept"` or an
  exec-policy amendment), the harness cannot make the kit's string a native
  id: it then returns `nativeOptionIds`, the native option id the driver will
  see for each of the kit's option ids, and the scenarios look for and answer
  with those. `nextReply()` and `replies()` still answer with the kit's ids.
  The mapping must be one-to-one, and the harness must work it out from the
  protocol and the driver's documented option ids, not by calling the driver:
  the kit fails a scenario whose mapping sends two kit options to one native
  option, because a reply could then not say which one the host chose.
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
- **`completeHeld`** ends the turn on the native side exactly as `complete`
  does (the provider has no active turn any more and refuses a steer the way
  it refuses one after a turn ended), but holds back the message that tells
  your driver until `release()`. Scenario 7 sends a steer in between, while
  your driver still believes the turn is running.
- **`inspectSession`** reads the native session behind a thread
  (`thread.handle`, else `thread.native.id`) from the native side: your
  fake's own state, not your driver's. Return `loaded: true` while a running
  fake agent holds the session, and the stored state with `loaded: false`
  when only its files or records remain; `undefined` when the fake has no
  such session. Scenario 9 uses it to see that a resumed thread kept its
  history and that each turn reached the native session the thread names.
  Scenario 14 uses it to see that a fork carries the source's history in its
  own native session and directory, and that compaction, history injection,
  rollback, unload, release and stopping a task or subagent changed the
  native session.
- **`activity`** lists what your fake agent served that is not a session's
  state: feedback uploads with the id it answered, MCP app operations with
  their input and the output it produced, and extension calls with their
  params and result. Report outputs in ARI's shapes (`McpTool[]`,
  `McpCallResult`, `McpResourceContents`) so the kit can compare them with
  what your driver returned; your harness knows both protocols. Make each
  output something only the native side could produce (the reference echo
  tool numbers its calls), so a driver cannot answer from its own guess.

Optional puppet members are needed only when your driver declares the
matching capability: `startBackgroundTask` for `background.*`,
`spawnSubagent` for `subagents.stop`, `nextSteer` and `completeHeld` for
`turns.steer`, `inspectSession` for scenario 9 and for `threads.fork`,
`threads.compact`, `threads.injectHistory`, `threads.rollback`,
`threads.unload`, `sessions.release`, `background.stop` or `subagents.stop`,
and `activity` for `sessions.feedbackUpload`, `tools.mcpApps` or any
extension namespace. Without them, the check fails unless you give a reason
(see [Applicability](#applicability)).

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
import { toSpawnedProcess, instanceDirectories, watchInstanceFiles, createConformanceWorkspace } from "../helpers/conformance.ts";

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
        watchInstanceFiles,
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
    watchInstanceFiles,
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
    watchInstanceFiles,
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
those checks, **before it asks your harness for the rig**. Every timer your
driver makes for the check is therefore virtual, including one it makes in
`create` or when the session opens and re-arms later with `refresh()`. The
clock replaces this realm's `setTimeout`, `clearTimeout`, `setInterval`,
`clearInterval`, `Date` (`new Date()` and `Date.now()`) and
`performance.now()`; its handles have Node's `ref`, `unref`, `hasRef` and
`refresh` (which, as in Node, runs a timer that already fired again).

Virtual time never runs slower than real time. While the kit waits for
something, it moves the clock on by the real time that passed, so a short real
wait in your driver (a back-off, a debounce) still ends. Only the pause jumps
ahead, in 250 ms steps with real I/O between them. A driver that settles a turn
from an ordinary quiet timer, either a `setTimeout` re-armed on every frame or a
`setInterval` comparing `Date.now()` against the last frame, sees its timer
fire at the 30-second mark and is caught, while the test takes well under a
second. The kit's own deadlines keep real time.

Virtual time does not reach `setImmediate`, `queueMicrotask`,
`process.nextTick` (all stay real, so I/O and promises keep running), timers
your driver made before the scenario began (at module load, or in an earlier
scenario), timers taken from `node:timers` or `node:timers/promises`
directly, `AbortSignal.timeout`, or anything in another process. If your
driver runs in another process (behind `ari/wire`) or keeps its timers that
way, set `time: "real"`: the scenarios then wait the full 36.5 seconds and
the poison's whole lifetime.

## The scenarios

| # | Key | The kit checks | The harness provides | Not applicable when |
|---|---|---|---|---|
| 1 | `grammar` | Every session stream of the run, read from `seq` 1, keeps the `ari/host` EventGrammar in strict mode. Its own stream adds a rich turn (text, a tool, an approval if available) and a stopped turn. | - | never |
| 2 | `turn-completed` | The turn stays open after its assistant message ends; after the provider completes it, `turn.terminal` is `completed` and `reusable`, the turn's assistant text is what the agent said, no item is left open, and the thread takes the next turn. | `say`, `complete` | never |
| 3 | `turn-interrupted` | `interruptTurn` reaches the agent; `turn.terminal` is `interrupted`; nothing is left open; a thread the driver calls `reusable` takes the next turn. | `stopRequested`, `finishCancelled` | never |
| 4 | `turn-failed` | A provider error ends `failed` with failure class `provider_error`, and a thread the driver calls `reusable` takes the next turn; a usage limit ends `failed` with class `usage_limit` and the provider's `resetAt`. | `fail` | check `turn-failed.usage_limit` |
| 5 | `process-exit` | The agent's process dying mid-turn ends the turn `failed` with a valid failure; a thread the driver calls `reusable` takes the next turn. | `exitProcess` | never |
| 6 | `settlement` | Nothing settles the turn (no `turn.terminal`, no `turn.upsert` with a settled status) from its start, through the tool result and a 36.5 s pause after it, until the provider completes it; then it completes. The clock is installed before the rig exists. | `runTool`, `complete` | never |
| 7 | `steer-after-end` | A steer after the turn ended returns `prompt_required`. So does a steer that arrives after the provider ended the turn but before the driver heard (`completeHeld`): the driver steers, the provider refuses, and the host must still get `prompt_required`. The provider never sees either as a turn. | `complete`, `completeHeld` | `turns.steer` off; check `steer-after-end.race` |
| 8 | `duplicate-always-options` | An approval with two `accept_always` options and a decline is an approval kind (not `user_input`), with no questions, keeping each native option id and an accepting or declining decision; answering with the second `accept_always` option sends that native option, not the first one with the same decision. | `requestApproval` | `approvals.command` and `approvals.fileChange` off, `requests.responseModes` without `live`, or no supervised runtime mode |
| 9 | `session-replaced` | Resuming an available session keeps its thread, replaces nothing, and the thread runs a turn whose prompt reaches the native session that still holds the earlier history. Resuming a locked session, then a missing one, falls back to a fresh session, emits `session.replaced` with `contextLost: true`, and the replacement thread runs a turn that reaches its own native session. | `lockSession`, `inspectSession` | checks `session-replaced.locked`, `session-replaced.native-history` |
| 10 | `auth-states` | A stored unchecked credential is `configured` and Send works, even with the ambient account signed out; an unanswerable check is `unavailable` and Send works; an undecidable one is `unknown`; `reportRuntimeFailure` poisons only its own scope (`runtime_poison`, `unauthenticated`, the scope of the instance that failed, a short `poisonExpiresAt`, the other instance unchanged); `auth.state()` reports `unauthenticated` with `runtime_poison` right after the failure and still one second before `poisonExpiresAt`; after it, the instance reports its verdict from before the failure and Send works; inherited credentials never reach the agent. | `ambientAuth` arrangements, `managedProfile` secrets, `inheritedCredentials` | `Instance.auth` left out; checks `auth-states.configured`, `.unavailable`, `.unknown`, `.poison`, `.inherited-credentials` |
| 11 | `symlinked-workspace` | A thread created in the real path reports that path as its cwd, and its tool paths lie inside it. A thread created through the symbolic link has the same id and cwd, and every event the same ids and paths. | `workspace().symlinkedCwd` | `symlinked-workspace` |
| 12 | `side-effect-free-probe` | `probe()` and `probe({ deep: true })` return valid results that report the agent `installed`, call no `secrets.set`, `secrets.delete`, `callbacks.register`, `coordination.acquire` or `hostTools.*`, spawn only the probe executables, and create, change or remove no file under the instance's paths at any moment while they run. | `watchInstanceFiles`, `probeExecutables` | check `side-effect-free-probe.files` |
| 13 | `replay-from-seq` | `events({ fromSeq: 1 })` and `events({ fromSeq: middle })` replay exactly the live events (same `seq`, same ids, same bodies), and the replayed stream goes on live identically. | `say`, `runTool`, `complete` | never |
| 14 | `capability-honesty` | Every capability-gated member the driver declares off is left out or rejects with `unsupported{capability}`; every one it declares on returns a valid result, has its effect, and returns what the native side produced. See below. | the optional puppet members, `inspectSession`, `activity` and `exercise` its declarations need | checks `capability-honesty.<member>`, `capability-honesty.native-effects` and `capability-honesty.native-activity` |
| 15 | `idempotent-responses` | Three responses with one `(requestId, responseKey)`, two of them concurrent, have one outcome and reach the agent once. A second request in the same session answered with the same `responseKey` is another pair and reaches the agent too. Under `full_access`, the reply the agent gets is the narrowest accepting option, whether the driver answers itself or hands the request to the host's `fullAccessAutoReply`. | `requestApproval` | as scenario 8; the `full_access` part is skipped with a note when `runtimePolicy.modes.full_access` is off, or when the harness gives a reason under `idempotent-responses.full-access` |

Scenario 14 checks the members below, with the capability paths that gate
them (`GATED_MEMBERS` holds the table, and a test keeps it in step with
`spec/v1/methods.json`). It calls your driver's own session, without
`ari/host`'s guard, because the driver itself must be honest. A member
declared on must return a valid result, have its effect, and return what the
native side produced; a well-shaped answer that did nothing fails. Before the
checks, the thread has run three turns ("Start the build.", then the queued
turn or "Second task.", then "Third task."), with a background task and a
subagent started in the first.

| Member | Works when |
|---|---|
| `startTurn` steer | it is accepted under the steered turn's id with `accepted: "steered"`, and the agent receives the steer text |
| `startTurn` queue | it is accepted with `accepted: "queued"`, and the agent starts the queued prompt after the active turn |
| `backgroundTasks.list` | it lists the running task, whose id the next two checks use |
| `backgroundTasks.await` | it matches the running task |
| `backgroundTasks.stop` | the driver's list (or its `background.updated` events) no longer shows the task running, and natively the task stopped |
| `stopSubagent` | the subagent's status settles (`completed`, `failed`, `cancelled` or `interrupted`), and natively the subagent stopped |
| `readSnapshot` | the snapshot is of the thread, holds the three turns that ran, and has an item carrying each turn's prompt |
| `forkThread` at latest | the fork is a new thread on its own native session (not the source's), natively holds exactly the source's prompts, and runs a turn that reaches that native session |
| `forkThread` from a turn | as at latest, but forked from the second of the three turns: natively it holds the prompts before that turn or up to and including it (the proposal does not choose, so both pass); a blank fork or a fork at the latest turn fails |
| `forkThread` from an item | as from a turn, for an item of the second turn |
| `forkThread` into another directory | as at latest, and the fork reports `otherCwd` as its cwd and its native session works there |
| `compactThread` | natively, the session's compaction count grew |
| `injectHistory` | it returns a valid result, and natively the session received each injected message, in order |
| `uploadFeedback` | the agent took an upload during the call and answered the feedback id the driver returned |
| `mcpApps.listTools` | the list includes `exercise.mcpApp.tool`, and the server listed the same tool names during the call |
| `mcpApps.callTool` | the native tool ran during the call with the host's arguments, and the driver returned exactly what it produced |
| `mcpApps.readResource` | the server served the resource during the call, and the driver returned exactly what it produced |
| `ext` | a call in each declared namespace reached the agent with the host's params, and the driver returned the agent's result; an undeclared namespace is `unsupported` |
| `contextWindow` | it returns a positive integer or `undefined` (shape only, see below) |
| `canReuseContextUsage` | it returns a boolean (shape only, see below) |
| `rollbackThread` to the start | the snapshot lists no turns, and natively the session holds no prompts |
| `unloadThread` | natively the session is no longer loaded, and `resumeThread` brings the thread back, in the same Session or a fresh one from the same instance, to run a turn that reaches its native session |
| `release` | in a fresh session with one finished turn and nothing running or pending, `canRelease()` turns true within the step timeout (one that stays false fails: release could never be exercised), `release()` resolves, natively the session is no longer loaded, and the thread then runs a turn that reaches it |

"Natively" means read through `NativeAgent.inspectSession`; "the agent took",
"the server served" and "the native tool ran" mean read through
`NativeAgent.activity`. When your harness gives a reason under
`capability-honesty.native-effects` or `capability-honesty.native-activity`
instead, those checks are skipped with a note, and the ARI-side checks still
run.

### Checks that rest on shape alone

Every other check in the kit compares a result with an effect the kit or the
native side can see. These still check only that a value is well formed, for
the reason given:

| Scenario | What is checked for shape only | Why |
|---|---|---|
| 4 `turn-failed` | the failure's `message`, `code` and `retryable` | the provider words its own messages, and the proposal fixes no code or retry rule per class; the class and `resetAt` are checked |
| 5 `process-exit` | the failure's class | the proposal names no class for a process exit; the turn must end `failed` with a valid failure |
| 8 `duplicate-always-options` | each option's `scope` | both `always` options have the same reach here; scenario 15 checks scopes through the narrowest `full_access` reply |
| 12 `side-effect-free-probe` | `ok`, `version` and a deep probe's `auth` | the kit cannot know the installed version, and inventory I asks scenario 12 only for the absence of side effects; `installed` is checked |
| 14 `capability-honesty` | `contextWindow` | the proposal fixes only the type; a session's effective window may differ from the catalog's maximum, and the value has no effect the kit can observe |
| 14 | `canReuseContextUsage` | the proposal fixes only the type; a driver may refuse reuse even for one model name, for example a rolling alias |
| 14 | `backgroundTasks.await` beyond `matched` | `awaited: true` tells the driver the host now waits for the tasks; no native effect is common to every vendor |
| 14 | the outcome `stopSubagent` returns | the stop itself is checked natively; the outcome's fields are the driver's report of it |
| 14 | `readSnapshot`'s `requests` and its items other than the prompts | the kit's thread has no pending requests, and other items depend on what the vendor stores |
| 14 | `planConfigChange` | it is not capability-gated, so inventory I's scenario 14 does not cover it |

### What the probe file check can see

Scenario 12 starts `watchInstanceFiles` before the first `probe()` and stops
it after the second returns. The Node helper in `test/helpers/conformance.ts`
works like this, and harnesses that write their own should match it.

It sees:

- every file or directory created, written, renamed or removed under
  `stateDir`, `cacheDir` and `tmpDir`, by your driver or by any process it
  spawns, while the watch runs. That includes a file written and deleted
  again before `probe()` returns: each directory has its own non-recursive
  `fs.watch` (inotify on Linux), and inotify queues every event. Node's
  recursive watch is not used, because on Linux it misses such a file;
- a file created in a new directory, reported as that new directory when the
  write comes before the helper has started watching inside it;
- any file whose size or modification time differs from an inventory taken
  when the watch started, as a second net.

`stop()` writes a sentinel file and waits until the watch reports it, so every
change made before `stop()` was called has arrived. If the sentinel never
shows, `stop()` throws rather than vouch for a watch that saw nothing.

It cannot see:

- writes outside the three directories: the home directory, the system temp
  directory, or a target outside them reached through a symbolic link inside
  them;
- reads, or changes to access time only;
- writes that work left running by `probe()` makes after the second call
  returned and `stop()` saw its sentinel;
- anything before the three directories exist (the helper throws if one is
  missing; `instanceDirectories` creates them);
- on macOS, where `fs.watch` uses FSEvents, a create-and-delete pair that
  FSEvents merges into nothing. The kit is tested on Linux only.

The in-memory reference harness has no real files. Its agent's store reports
every write it makes to the watch, so the watch there sees exactly what that
agent writes under the instance's virtual paths, and nothing a driver writes
with `node:fs`.

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
support (a missing `lockSession`, `completeHeld`, `inspectSession`,
`activity` or `watchInstanceFiles`, an auth state it cannot arrange) fails the scenario
unless `notApplicable` has a reason under the check's key. The check keys are
`turn-failed.usage_limit`, `steer-after-end.race`, `session-replaced.locked`,
`session-replaced.native-history`, `auth-states.configured`,
`auth-states.unavailable`, `auth-states.unknown`, `auth-states.poison`,
`auth-states.inherited-credentials`, `side-effect-free-probe.files`,
`idempotent-responses.full-access` (for a native agent that sends no
approval under `full_access`, so no reply exists to check),
`capability-honesty.native-effects`, `capability-honesty.native-activity`,
`capability-honesty.background`, `capability-honesty.stopSubagent`,
`capability-honesty.turns.steer`, `capability-honesty.mcpApps`,
`capability-honesty.forkThread.crossCwd` and `capability-honesty.ext.<ns>`.
A skipped check becomes a note in the result. Nothing else makes a scenario
skip: a fake that lacks a step the scenario needs is a failure.

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
poison per scope, a probe that only runs `--version`, forks into another
directory, an unloaded thread that `resumeThread` loads again, and
`unsupported` for everything declared off. Its agent serves a native MCP
server (`reference-tools`, with an `echo` tool that numbers its calls and a
`reference://readme` resource that numbers its reads), a feedback endpoint
and the `reference.echo` extension, and records what it served for
`NativeAgent.activity`.

Its config: `profile` is `"full"` (every optional feature declared and
implemented) or `"minimal"` (all declared off, and no `auth`);
`fullAccessReplies` says whether the driver answers native approvals under
`full_access` itself, with the narrowest accepting option, or hands them to
the host.

`referenceHarness()` runs it against the reference agent in memory, with a
virtual workspace and filesystem, so it works in a browser.
`test/conformance/child-process-harness.ts` runs the same driver against the
same agent as a real child process, with real files and a real symbolic link.
Both implement every optional puppet member (`completeHeld`,
`inspectSession` and `activity` included) and pass all 15 scenarios.

## How the kit proves itself

`test/conformance/broken-drivers.ts` holds 66 deliberately broken variants of
the reference driver. Each wraps the honest driver and adds one bug the way a
production driver has broken; `test/conformance/broken.test.ts` asserts each
fails its scenario for that reason, and that the honest driver passes the same
scenarios. Many are bugs that return the right shape and skip the effect.
`test/conformance/kit.test.ts` also asserts that honest answers the proposal
allows pass: a context window below the catalog's, refused usage reuse, an
unloaded thread that only a fresh Session can resume, and a fork from a turn
that excludes that turn.

| # | Variants | The bugs |
|---|---|---|
| 1 | 1 | a delta before its item opens |
| 2 | 3 | completion reported as interrupt; the turn settled when its message ends; a completed turn kept active, so the "reusable" thread refuses the next turn |
| 3 | 2 | Stop that never reaches the agent; an interrupted turn kept active |
| 4 | 2 | a usage limit classified as a provider error; a failed turn kept active |
| 5 | 1 | a turn left open when the process dies |
| 6 | 3 | a 30-second quiet timer re-armed per event; a turn settled by a tool result; one 30-second timer made when the session opens and `refresh()`ed per event |
| 7 | 2 | a late steer that starts a turn; the provider's "no active turn" refusal surfaced as an error unless the driver already heard the turn end |
| 8 | 2 | duplicate `always` options turned into a question; the reply sent as the first option with the chosen decision |
| 9 | 4 | a silent session swap; a placeholder thread no native session backs as the fallback; a remembered thread returned on resume without loading its native session; a resume onto a fresh native session under the old thread's id |
| 10 | 6 | a configured credential treated as signed out; inherited credentials passed to the agent; the poison reported under the ambient scope; a poisoned instance kept signed out after expiry; a poisoned instance reported `configured` while the poison is active; a poison lifted after one second of an advertised thirty |
| 11 | 2 | the workspace path reported as given; the requested directory ignored |
| 12 | 4 | a probe that writes secrets and takes a lease; one that opens a native session; one that writes a scratch file under `tmpDir` and deletes it before returning (run with the child-process harness, on real files); one that reports "not installed" without looking |
| 13 | 1 | a replay that renumbers `seq` |
| 14 | 30 | readSnapshot declared off but served; fork from an item declared on but refused; a cross-directory fork that stays in the source directory; a compaction that does nothing; `canRelease()` always false; a `release()` that parks nothing; a snapshot without the thread's turns; a steer accepted under another turn's id; a queued turn reported as started; a snapshot whose turns have no items; a fork no native session backs; a fork from a turn made at the latest turn; a rollback that only empties the returned snapshot; history reported consumed but never sent; an unload that unloads nothing; a background stop that stops nothing; an await that matches nothing; a subagent stop that stops nothing; blank forks at the latest turn and from a turn; a cross-directory fork under a thread id the driver never registered; the source thread returned as its own fork; placeholder messages injected instead of the host's; a background stop only in the driver's own list; a subagent stop only in the driver's events; a made-up feedback id; an MCP tool call, resource read and tool list answered without the server; an extension call answered with nothing; an MCP server listed with no tools |
| 15 | 3 | responses that are not idempotent; an `always` option mislabelled as reaching once; responses cached by `responseKey` alone, so a second request answered with the same key never reaches the agent |

Write your own the same way when you add a check: a wrapper around an honest
driver that adds one bug, which passes the scenario before your check exists
and fails it after.
