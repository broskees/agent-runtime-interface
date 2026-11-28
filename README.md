# ari

ARI (Agent Runtime Interface) is a provider-neutral runtime contract for apps
that drive coding agents: Claude, Codex, Cursor, OpenCode, Pi, Muse and any
agent that speaks the Agent Client Protocol (ACP). It is one standalone
package with zero runtime dependencies. It holds the contract, a host
toolkit, a conformance kit, Node host services, a JSON-RPC stdio wire,
first-party drivers, Effect bindings, and the JSON Schema that clients in
other languages generate from.

> `ari` is a working name. The package is not published yet.

## Install

```bash
npm install ari
```

- Node 22.16 or later for the Node subpaths and the drivers. The browser-safe
  subpaths (see the table) run on any modern JavaScript runtime. CI runs the
  test suite, the conformance kit and both quickstarts below under Bun as well
  as Node.
- TypeScript consumers need `moduleResolution` set to `node16`, `nodenext` or
  `bundler`.
- `dependencies` is empty. Vendor SDKs and `effect` are optional peers: install
  only what you use. A driver whose SDK or CLI is missing still loads; its
  instance's `status()` reports it unavailable and names what to install, and
  `openSession` rejects with `driver_unavailable`.

ARI installs nothing. It never downloads, unpacks, installs or updates a
vendor CLI, an agent or an SDK package. The user or the host installs every
one in this table:

| You use | Also install |
|---|---|
| `ari/drivers/claude` | Claude Code 2.1.330 or newer, the user's own `claude` on `PATH` (or `executablePath`); and, under Node, `@anthropic-ai/claude-agent-sdk` 0.3.330 next to ari (the standalone `ari-driver` includes it) |
| `ari/drivers/cursor` | `@cursor/sdk` |
| `ari/drivers/opencode` | the `opencode` CLI, plus `@opencode-ai/sdk` for an OpenCode 1.x server or `@opencode/client` for 2.x |
| `ari/drivers/muse` | `@muse-code/sdk` and the `muse` CLI |
| `ari/drivers/pi`, `codex`, `grok`, `fx`, `kiro`, `antigravity` | the agent's own CLI on `PATH` (`pi`, `codex`, `grok`, `fx`, `kiro-cli`, `agy`) |
| `ari/drivers/acp` | any ACP agent, such as one from the ACP Registry; you install it and configure its command |
| `ari/effect` | `effect@^4` |

## Subpaths

| Import | What it is | Runs on |
|---|---|---|
| `ari` | The contract: generated wire types, zero-dependency validators that implement Standard Schema v1, call errors and failure classes, the patch and capability helpers, and the `Driver`, `Instance`, `Session` and `HostServices` interfaces | any runtime |
| `ari/host` | Host toolkit: the event grammar validator (`strict`, `warn`, `repair`), the event reducer, the request ledger, the capability guard and fallback planner, the approval reviewer hook, the replay recorder | any runtime |
| `ari/driver-kit` | For driver authors: the event sequencer, deterministic IDs, an NDJSON framer, a JSON-RPC 2.0 peer, UTF-8 truncation | any runtime |
| `ari/node` | Host services for Node: process spawning with environment rules, file-backed secrets, per-instance paths, coordination leases, diagnostics, sign-in callbacks, and `createNodeHostServices` to combine them | Node |
| `ari/wire` | ARI over newline-delimited JSON-RPC 2.0 on stdio: `startAriDriver` and `connectDriver` for hosts, `serveDriver` for drivers | Node |
| `ari/conformance` | The conformance kit: 15 scenarios, a fake host that records every call, a `node:test` adapter, replay fixtures, and an in-memory reference driver that passes every scenario | any runtime |
| `ari/effect` | Effect services for the runtime interfaces, session events as a `Stream`, tagged call errors, and generated Effect schemas | needs `effect` |
| `ari/drivers/<name>` | The 11 first-party drivers: `pi`, `acp`, `grok`, `fx`, `kiro`, `antigravity`, `codex`, `claude`, `opencode`, `cursor`, `muse` | Node |
| `ari/meta/<name>` | Each driver's label, icon, config JSON Schema and form hints, without loading the driver | any runtime |
| `ari/cli-manifests` | CLI launch manifests and the function that builds argv and env for fresh, resume and fork launches | any runtime |
| `ari/json-schema/*.json` | The wire contract as JSON Schema draft 2020-12, plus `methods.json`, which lists every `ari/wire` method | data |

The package also ships the `ari-driver` bin, which serves a driver over
`ari/wire`: `ari-driver pi` for a first-party driver, or
`ari-driver ./my-driver.js` for any module that exports a driver. Each GitHub
release also carries a standalone `ari-driver` executable for linux-x64,
linux-arm64, darwin-x64, darwin-arm64 and windows-x64, so a host written in
another language needs no Node installed. Beside them is
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md), the notice for the SDK
code they include.

The `claude` driver always runs the user's own Claude Code: the `claude` on
the host's `PATH`, or the one the config's `executablePath` names, never a
Claude Code that npm installed beside the SDK. ARI never downloads
Claude Code. It must be 2.1.330 or newer, the version the pinned SDK bundles.
When it is missing, `status()` reports `driver_unavailable` saying Claude
Code is not installed and how to install it; when it is older, the error
names the version and path found, the minimum, and to run `claude update`
or set `executablePath`. If the driver cannot read the version, `status()`
reports `driver_unavailable` with the executable's path and what
`claude --version` printed, if it ran.

The standalone executable includes the JavaScript of the Claude Agent SDK,
`@anthropic-ai/claude-agent-sdk` 0.3.330, so its `claude` driver needs no
SDK install and no config: only the user's `claude`. It includes no Claude
Code. The SDK is © Anthropic PBC and under Anthropic's terms
(https://code.claude.com/docs/en/legal-and-compliance), not under ARI's MIT
License; `THIRD-PARTY-NOTICES.md` says so, and each release attaches it
beside the binaries. The npm package holds none of the SDK's code: under
Node the SDK is an optional peer you install, and without it `status()`
reports `driver_unavailable` naming the npm command.
[docs/drivers/claude.md](docs/drivers/claude.md) has the details.

Each driver has a page in [`docs/drivers/`](docs/drivers/) and a changelog in
[`changelogs/`](changelogs/).

## Quickstart: in process

A host creates an instance of a driver with its host services, opens a
session, creates a thread and starts a turn. Then it reads the session's
events until the turn's `turn.terminal`, answering requests such as approvals
on the way.

This program uses the conformance kit's reference driver and its fake host,
so it runs anywhere without an account. Its agent is in memory and does only
what `playAgent` tells it. With a real driver, such as `claudeDriver` from
`ari/drivers/claude`, the agent acts on its own, so `playAgent` goes away, and
the host services come from `createNodeHostServices` in `ari/node`.

<!-- example: examples/in-process.ts -->
```ts
// Drive a driver in process: create an instance, open a session, create a
// thread, start a turn, answer the approval it asks for, and read events until
// the turn's `turn.terminal`.
//
// The driver is the conformance kit's reference driver. Its agent runs in
// memory and acts only on the script in `playAgent`, so this runs anywhere
// with no account. A real driver's agent acts on its own: drop `playAgent`.
import type { RequestOption } from "ari";
import { REFERENCE_WORKSPACE, createFakeHost, referenceHarness } from "ari/conformance";

const rig = await referenceHarness().setup({ scenario: "quickstart", workspace: REFERENCE_WORKSPACE, ambientAuth: "authenticated" });
const driver = rig.driver;
const config = driver.defaultConfig();
const host = createFakeHost({ ...(await rig.hostOptions?.("quickstart", { managedProfile: false })), config });

const instance = await driver.create(host, { instanceId: "quickstart", config, environment: {} });
const session = await instance.openSession({});
const cwd = REFERENCE_WORKSPACE.cwd;
const thread = await session.createThread({ cwd, policy: { mode: "approval_required", interaction: "default", cwd } });

const started = await session.startTurn({
  threadId: thread.id,
  clientTurnKey: "quickstart-turn-1",
  intent: "start",
  content: [{ type: "text", text: "List the files." }],
});
if (started.status !== "accepted") throw new Error(`the turn was not accepted: ${started.status}`);

// The reference agent's side of the turn: ask to run `ls`, then answer.
async function playAgent(): Promise<void> {
  const turn = await rig.native.nextTurn();
  const approval = await turn.requestApproval({
    kind: "command",
    command: ["ls"],
    options: [
      { optionId: "allow", label: "Allow", decision: "accept" },
      { optionId: "deny", label: "Deny", decision: "decline" },
    ],
  });
  const reply = await approval.nextReply();
  await turn.say(reply === "allow" ? "README.md and src/." : "I did not run ls.");
  await turn.complete();
}
const agent = playAgent();

let reply = "";
for await (const event of session.events()) {
  const body = event.body;
  if (body.type === "request.upsert" && body.request.status === "pending") {
    // Approve once: pick the option that accepts without widening the scope.
    const accept = body.request.options?.find((option: RequestOption) => option.decision === "accept");
    if (accept === undefined) throw new Error("the approval offers no accept option");
    console.log(`approving: ${accept.label}`);
    await session.respond({ requestId: body.request.id, responseKey: "quickstart-answer-1", optionId: accept.optionId });
  }
  if (body.type === "item.delta" && body.field === "text") reply += body.chunk;
  if (body.type === "turn.terminal" && body.turnId === started.turnId) {
    console.log(`assistant: ${reply}`);
    console.log(`turn ${body.status}`);
    break;
  }
}

await agent;
await session.close();
await instance.dispose();
await rig.dispose?.();
```

Save it as `in-process.ts` in a project that has `ari` installed and run
`node in-process.ts` (Node 22.18 or later runs TypeScript directly). It
prints:

```text
approving: Allow
assistant: README.md and src/.
turn completed
```

## Quickstart: over `ari/wire`

The same driver can run in another process. `ari-driver` serves a driver over
newline-delimited JSON-RPC 2.0 on its stdin and stdout, and `startAriDriver`
starts it and returns a `Driver` that works like an in-process one. Every call
and event crosses the wire, so a host in Rust, Python or Go can do the same
with the clients in [`clients/`](clients/README.md) and the protocol in
[`docs/wire.md`](docs/wire.md).

`ari-driver` loads a driver by module path. Any module that exports a driver
works:

<!-- example: examples/reference-driver.ts -->
```ts
// A driver module for `ari-driver <module path>`. Any module that exports an
// object implementing `Driver` works; this one re-exports the conformance
// kit's reference driver.
export { referenceDriver } from "ari/conformance";
```

The host starts `ari-driver` on that module. It offers process delegation,
so the driver's spawn of its agent comes back to the host, where the
reference agent still runs in memory:

<!-- example: examples/over-the-wire.ts -->
```ts
// Drive the same reference driver over ari/wire. `startAriDriver` runs the
// package's `ari-driver` bin on a driver module and speaks newline-delimited
// JSON-RPC 2.0 with it on stdio; the `Driver` it returns works like an
// in-process one. Hosts in other languages speak the same protocol.
//
// `delegateProcesses` sends the driver's process spawns back to this host, so
// the reference agent still runs in memory here and plays `playAgent`.
import { fileURLToPath } from "node:url";
import type { RequestOption } from "ari";
import { REFERENCE_WORKSPACE, createFakeHost, referenceHarness } from "ari/conformance";
import { startAriDriver } from "ari/wire";

const rig = await referenceHarness().setup({ scenario: "quickstart", workspace: REFERENCE_WORKSPACE, ambientAuth: "authenticated" });
const connection = await startAriDriver({ driver: fileURLToPath(new URL("./reference-driver.ts", import.meta.url)), delegateProcesses: true });
console.log(`connected: ARI ${connection.negotiated.ariVersions.driver}, event grammar ${connection.negotiated.grammarVersion}`);
const driver = connection.driver;
const config = driver.defaultConfig();
const host = createFakeHost({ ...(await rig.hostOptions?.("quickstart", { managedProfile: false })), config });

const instance = await driver.create(host, { instanceId: "quickstart", config, environment: {} });
const session = await instance.openSession({});
const cwd = REFERENCE_WORKSPACE.cwd;
const thread = await session.createThread({ cwd, policy: { mode: "approval_required", interaction: "default", cwd } });

const started = await session.startTurn({
  threadId: thread.id,
  clientTurnKey: "quickstart-turn-1",
  intent: "start",
  content: [{ type: "text", text: "List the files." }],
});
if (started.status !== "accepted") throw new Error(`the turn was not accepted: ${started.status}`);

// The reference agent's side of the turn: ask to run `ls`, then answer.
async function playAgent(): Promise<void> {
  const turn = await rig.native.nextTurn();
  const approval = await turn.requestApproval({
    kind: "command",
    command: ["ls"],
    options: [
      { optionId: "allow", label: "Allow", decision: "accept" },
      { optionId: "deny", label: "Deny", decision: "decline" },
    ],
  });
  const reply = await approval.nextReply();
  await turn.say(reply === "allow" ? "README.md and src/." : "I did not run ls.");
  await turn.complete();
}
const agent = playAgent();

let reply = "";
for await (const event of session.events()) {
  const body = event.body;
  if (body.type === "request.upsert" && body.request.status === "pending") {
    const accept = body.request.options?.find((option: RequestOption) => option.decision === "accept");
    if (accept === undefined) throw new Error("the approval offers no accept option");
    console.log(`approving: ${accept.label}`);
    await session.respond({ requestId: body.request.id, responseKey: "quickstart-answer-1", optionId: accept.optionId });
  }
  if (body.type === "item.delta" && body.field === "text") reply += body.chunk;
  if (body.type === "turn.terminal" && body.turnId === started.turnId) {
    console.log(`assistant: ${reply}`);
    console.log(`turn ${body.status}`);
    break;
  }
}

await agent;
await session.close();
await instance.dispose();
await connection.close();
await rig.dispose?.();
```

Save both files side by side and run `node over-the-wire.ts`. It prints:

```text
connected: ARI 1.0.0, event grammar 1
approving: Allow
assistant: README.md and src/.
turn completed
```

Without `delegateProcesses`, `ari-driver` spawns the driver's processes
itself, applying the `envPolicy` the host sends in `initialize`.

## Validate wire data

Every schema definition has a validator that implements
[Standard Schema](https://standardschema.dev/schema) v1 and
[Standard JSON Schema](https://standardschema.dev/json-schema) v1.

```ts
import { AriEventSchema } from "ari";

const result = AriEventSchema["~standard"].validate(incoming);
if (result.issues) {
  console.error(result.issues);
}
```

Unknown enum values and `x:` extension variants validate and come back
unchanged, so newer drivers never break older hosts.

## Extensions and escape hatches

A host never has to wait on an ARI release:

1. **Host-owned extension namespaces.** Event types, item kinds, request
   kinds and other extensible sets take `x:` names, and validators keep
   unknown values. The `x:host.<name>.` prefix is reserved for hosts and needs
   no upstream approval, so a host can name its own additions
   `x:host.myapp.*` without asking ARI or any driver. A driver lists its own
   extension namespaces in
   `capabilities().extensions`, and a host calls them with
   `session.ext(namespace, method, params)`.
2. **Bring your own driver.** The contract is structural: any object that
   implements `Driver` works, in process or served by
   `ari-driver ./my-driver.js`. A host can keep private drivers, or replace a
   first-party driver, without forking the package. Run `ari/conformance`
   against it to check it keeps the contract.
3. **Native passthrough.** Events may carry a bounded `native` copy of the
   provider frame they came from, for diagnostics, and
   `RuntimePolicy.native` passes a provider-native policy through unchanged.
4. **Pin or patch.** Package-manager overrides (`overrides` in npm,
   `pnpm.overrides`) or a patch (`pnpm patch`, `patch-package`) cover an
   urgent fix until it is released.

## Vendor CLIs

ARI installs nothing: the user or the host installs every CLI and SDK.
ARI runs the vendor CLI the user installed and never downloads, installs or
updates one. Each CLI driver finds its CLI on `PATH`, or at the path its
config names, and asks it for its version. The minimum is the lower bound of
the driver's tested range. With a CLI older than that, `status()` is
`unavailable` with `driver_unavailable`, and `openSession` rejects with the
same error before any agent starts. The error names the version found, the
path, the minimum and the vendor's own update step, for example:

```text
Codex CLI 0.100.0 (/usr/local/bin/codex) is older than 0.172.0, the oldest version this driver supports. Update Codex using your installation method (npm: `npm install -g @openai/codex`; Homebrew: `brew upgrade --cask codex`). For the standalone installer, rerun the installer from https://learn.chatgpt.com/docs/codex/cli. For a manually downloaded release binary, replace it with the appropriate binary from https://github.com/openai/codex/releases/latest. For other package managers, update with the manager that installed it.
```

A CLI above the tested range still runs, with an `untested_version` advisory.

| Driver | CLI | Minimum | Update step |
|---|---|---|---|
| `antigravity` | `agy` | 1.5.0 | `agy update` |
| `codex` | `codex` | 0.172.0 | [Update using your installation method](docs/drivers/codex.md#the-users-own-codex-and-its-minimum) |
| `fx` | `fx` | 0.0.13 | `fx upgrade` |
| `grok` | `grok` | 1.0.70 | `grok update` |
| `kiro` | `kiro-cli` | 3.0.0 | `kiro-cli update` |
| `muse` | `muse` | 1.4.25 | run the installer again: `curl -fsSL https://dev.meta.ai/install.sh \| bash` |
| `opencode` | `opencode` | 1.19.6 for 1.x, 2.1.2 for 2.x | `opencode upgrade` |
| `pi` | `pi` | 1.6.0 | `pi update` |

Each driver's page in [`docs/drivers/`](docs/drivers/) cites the vendor's
documentation for its update step.

## Environment

ARI passes the environment through. Each driver gives its agent the
environment the host gives it, credentials such as `ANTHROPIC_API_KEY`
included, as if the user had run the CLI in that shell. A host that wants a
variable kept from agents lists it in `envPolicy.stripAmbient`: a name, or a
prefix ending in `*`. An instance's own credential, stored through its `auth`
methods, still wins over an inherited one.

## Versions

ARI keeps three version axes apart:

- the npm package version, for driver fixes and vendor bumps;
- the contract version, negotiated in the `ari/wire` handshake: `ariVersion`,
  a range of event grammar versions, and a `{ major, minor }` version per
  method;
- the persistence version of stored session handles and replay fixtures.

Each driver declares the vendor versions it is tested against and reports a
version advisory in `status()` when the installed SDK or CLI is outside that
range; a vendor CLI older than the range is refused instead (see
[Vendor CLIs](#vendor-clis)).

## More documentation

- [`spec/v1/README.md`](spec/v1/README.md): the normative contract, its
  conventions, the event grammar and the wire protocol. TypeScript types and
  validators are generated from it.
- [`docs/wire.md`](docs/wire.md): `ari/wire` for client authors.
- [`docs/conformance.md`](docs/conformance.md): plugging a driver into the
  conformance kit, and the fixture format.
- [`docs/effect.md`](docs/effect.md): `ari/effect`.
- [`docs/drivers/`](docs/drivers/): one page per driver, with its capabilities.
- [`clients/README.md`](clients/README.md): the Rust, Python and Go clients.
- [`CHANGELOG.md`](CHANGELOG.md) and [`changelogs/`](changelogs/): the package
  and per-driver changelogs.
- [`SECURITY.md`](SECURITY.md): reporting a vulnerability, and how releases
  are built and published.

## License

MIT. See [`LICENSE`](LICENSE). The standalone `ari-driver` executables also
include the Claude Agent SDK, under Anthropic's terms; see
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
