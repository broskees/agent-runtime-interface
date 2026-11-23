# ARI wire contract, version 1

This directory is the single source of truth for ARI's wire data. Every file
here is hand-written. `pnpm run codegen` generates from it:

- TypeScript types and zero-dependency validators in `src/generated/`, one
  module per schema file;
- the published copies in `json-schema/`, one file per schema file, plus
  `methods.json`.

`pnpm run codegen:check` fails when a generated file differs from what codegen
would write now. Never edit generated files by hand.

## Files

| File | Holds |
|---|---|
| `common.schema.json` | identity (`NativeRef`, `RefStrength`), versions, content blocks, extension names |
| `errors.schema.json` | the 11 call errors and the 6 failure classes |
| `capabilities.schema.json` | the 12 capability groups and ARI's additions |
| `config.schema.json` | config options, runtime policy, slash commands, skills, config change plans |
| `thread.schema.json` | threads, turns, their patch forms, fork and rollback points, snapshots, session handles |
| `item.schema.json` | items and item patches |
| `request.schema.json` | requests (approvals, questions, elicitation) and request patches |
| `subagent.schema.json`, `plan.schema.json` | subagents, plans and their patches |
| `background.schema.json`, `usage.schema.json` | background tasks, usage, limits, reset credits |
| `events.schema.json` | the event envelope and its 19 body variants |
| `session.schema.json`, `instance.schema.json`, `driver.schema.json`, `host.schema.json` | inputs and results of the runtime interfaces |
| `handshake.schema.json` | the `initialize` exchange and its three version axes |
| `fixture.schema.json` | replay fixtures: a recorded session's calls, results and events, with a persistence version |
| `rpc.schema.json` | JSON-RPC params and results for each method in `methods.json` |
| `method-table.schema.json` | the format of `methods.json` |
| `methods.json` | every wire method, its direction, params, result and how it streams |
| `extensions/<ns>.schema.json` | extension schemas, such as the shared experimental `ari.goal` |

## Conventions

- Every schema file is JSON Schema draft 2020-12 with an `$id` under
  `https://ari.invalid/spec/v1/`. The host `ari.invalid` is a placeholder, like
  the package name `ari`. References between files are relative, for example
  `common.schema.json#/$defs/NativeRef`, so they resolve from disk too.
- Definition names are unique across all files, core and extensions, so
  generated modules can be re-exported side by side.
- **Open enums.** Unknown enum values are accepted and kept. An enum is written
  as `anyOf: [{ "enum": [...] }, { "type": "string" }]`.
- **Extensible sets.** Where a set grows by extension (item kinds, request
  kinds, event types, limit windows), the extra values are `x:` names:
  `anyOf: [{ "enum": [...] }, { "$ref": "common.schema.json#/$defs/ExtensionName" }]`.
  The `x:host.<name>.` prefix is reserved for hosts and needs no upstream
  approval.
- **Tagged unions** (`oneOf` whose variants each fix a `type`, `mode`, `status`
  or `code` with `const`) accept only their listed variants, plus an `x:`
  variant where the union lists one.
- Objects accept and keep unknown properties: no schema sets
  `additionalProperties: false`.
- **Patch forms** (`ThreadPatch`, `TurnPatch`, `ItemPatch`, `RequestPatch`,
  `SubagentPatch`, `PlanPatch`) follow ACP v2: an omitted field is unchanged,
  `null` clears an optional field, and a value replaces the field whole. Nested
  objects and arrays are replaced whole, never merged. Only `id` is required in
  a patch.
- Timestamps are ISO-8601 strings.

## Event grammar

Every session stream satisfies these rules. `ari/host`'s `EventGrammar` checks
them; `ari/conformance` runs it in strict mode.

Definitions:

- An item **opens** with the first `item.upsert` that carries its id in the
  session. That upsert carries every field `Item` requires.
- An item **settles** with the first `item.upsert` that sets its `status` to a
  terminal status: `completed`, `failed`, `cancelled` or `interrupted`.
- A turn **starts** with the first `turn.upsert` that carries its id in the
  session. That upsert carries every field `Turn` requires.
- A turn **settles** with its `turn.terminal` event. Nothing else settles a
  turn: not a `turn.upsert` with a terminal status, and never a quiet timer.
  Drivers emit `turn.terminal` only on authoritative provider completion, an
  explicit cancel, or process exit (after a short grace period to drain
  notifications).

Invariants:

1. `item/opens-before-delta`: an `item.delta` for an item comes after the item
   opens and before it settles.
2. `item/settles-once`: an item settles at most once. After it settles, no
   `item.upsert` for it sets `status` again.
3. `turn/starts-once`: a turn starts at most once. A `turn.upsert` for a turn
   that already settled is a violation.
4. `turn/settles-once`: a turn has at most one `turn.terminal`.
5. `turn/known`: every `turn.terminal`, and every event whose envelope carries
   a `turnId`, names a turn that has started. The event that starts the turn
   may carry its own id.
6. `seq/gap-free`: `seq` is gap-free and increasing: the first event of a
   session has `seq` 1 and each next event has the previous `seq` plus 1.

The definitions add two rules, which `EventGrammar` reports by name:

7. `item/opens-complete`: the `item.upsert` that would open an item carries
   every field `Item` requires (`id`, `kind`, `native`, `status`).
8. `turn/starts-complete`: the `turn.upsert` that would start a turn carries
   every field `Turn` requires (`id`, `threadId`, `native`, `origin`,
   `status`).

An upsert that breaks rule 7 or 8 opens or starts nothing; the first later
upsert for that id that carries every required field opens or starts it.

`item.delta` is ephemeral: once an item settles, a host may drop its deltas,
because the settling `item.upsert` carries the full text.

## Wire protocol

`ari/wire` is newline-delimited JSON-RPC 2.0 over stdio. `methods.json` lists
every method. Its mapping rules:

- A method's params are the TypeScript argument object plus the target id
  (`instanceId` for instance methods and host services, `sessionId` for session
  methods). Positional TypeScript arguments become named fields.
- The result is the TypeScript return value; `void` and `undefined` are `null`.
- A rejected call carries a `CallError` in the JSON-RPC error's `data`: code
  -32000 for a call error the callee threw, -32601 (`unsupported`) for an
  unknown method, -32602 (`validation`) for params that fail their schema,
  -32603 (`protocol`, `detail: "uncaught_error"`) for anything else thrown.
- Streaming members return `{ streamId }`. Items arrive as the notification the
  entry names, only after that response, ending with `stream/end`; the
  consumer may send `stream/cancel`, which the producer answers before its
  `stream/end`.
- `driver/create` and `instance/openSession` answer descriptors whose
  `members` list the optional members the object has; `driver/create`'s
  `hostMembers` lists the optional host services the host serves.
- The host's `initialize` says whether it runs the driver's processes
  (`host.capabilities.process`). If not, the driver spawns locally with the
  `envPolicy` sent there, and looks executables up locally.
- Non-method members (`Session.id`, `Instance.bindingKey`, `Driver.metadata`,
  `HostServices.paths.stateDir` and so on) travel inside the params or results
  listed in the `properties` section of `methods.json`.
- `Instance.auth.transferSession` names its target instance by
  `targetInstanceId`, because an `Instance` object cannot be serialized.

docs/wire.md describes the protocol in full for client authors: the
handshake's negotiation rules, framing, processes, synchronous members and
what a client does when the driver process dies.

## Versions

Three axes are versioned independently:

1. The npm package version.
2. The contract: `ariVersion` (currently `1.0.0`), the event grammar version
   range (currently `[1, 1]`) and per-method `{ major, minor }` versions, all
   negotiated in `initialize`. Version 1 only grows by addition.
3. The persistence version `{ major, minor }` (currently `{ major: 1, minor: 0 }`)
   of stored session handles and event journals.
