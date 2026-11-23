# `ari/effect`: Effect bindings

`ari/effect` gives Effect users ARI's runtime interfaces as Effect services,
session events as a `Stream`, call errors as tagged errors, and Effect schemas
for every wire type. It is the only subpath that loads `effect`, an optional
peer dependency (`effect@^4.0.0`). Every other subpath works without it.

## Install

```sh
npm install ari effect@^4
```

Importing `ari/effect` without `effect` installed fails with
`ari/effect needs the optional peer dependency "effect" (^4.0.0), which is not installed`.
`ari/effect` loads Effect with a top-level `await import(...)`, so it is an
ES module with top-level await.

## Services

| Service key | Shape | Built from |
|---|---|---|
| `AriDriver` | `EffectDriver` | `toEffectDriver(driver)`, `AriDriver.layer(driver)` |
| `AriInstance` | `EffectInstance` | `toEffectInstance(instance)`, `AriInstance.layer(instance)`, `AriInstance.create(host, request)` |
| `AriSession` | `EffectSession` | `toEffectSession(session)`, `AriSession.layer(session)`, `AriSession.open(input)` |
| `AriHostServices` | `EffectHostServices` | `toEffectHostServices(host)`, `AriHostServices.layer(host)` |

Each shape has the members of the plain interface in `ari`:

- A method that returns a Promise or a value returns an `Effect`. Nothing runs
  until the Effect runs.
- A method that returns an `AsyncIterable` (`events`, `statusChanges`,
  `usageHistory.scan`, config changes, process output) returns a `Stream`.
  Each run of the stream calls the method again. Ending the stream early stops
  the iterator.
- Optional members stay optional, as on the wrapped object.
- `unwrapped` is the plain object.

`AriInstance.create` creates an instance with the `AriDriver` service and
disposes it when the layer is released. `AriSession.open` opens a session with
the `AriInstance` service and closes it when the layer is released.

```ts
import { Effect, Layer } from "effect";
import { AriDriver, AriInstance, AriSession } from "ari/effect";

const program = Effect.gen(function* () {
  const session = yield* AriSession;
  const thread = yield* session.createThread({ cwd: "/work", policy });
  return yield* session.forkThread!({ threadId: thread.id, at: { type: "latest" } }).pipe(
    Effect.catchTag("UnsupportedError", (error) => Effect.succeed(`fork is off: ${error.capability}`)),
  );
});

const live = AriSession.open({}).pipe(
  Layer.provide(AriInstance.create(host, { instanceId: "main", config: {}, environment: {} })),
  Layer.provide(AriDriver.layer(driver)),
);
await Effect.runPromise(program.pipe(Effect.provide(live)));
```

## Tagged errors

A call that rejects with an `AriError`, or with call error data that crossed
`ari/wire`, fails with the tagged error of its code:

| Code | Tagged error |
|---|---|
| `unsupported` | `UnsupportedError` |
| `invalid_state` | `InvalidStateError` |
| `not_found` | `NotFoundError` |
| `auth_required` | `AuthRequiredError` |
| `usage_limit` | `UsageLimitError` |
| `permission_denied` | `PermissionDeniedError` |
| `transport` | `TransportError` |
| `protocol` | `ProtocolError` |
| `validation` | `ValidationError` |
| `attachment_unreadable` | `AttachmentUnreadableError` |
| `driver_unavailable` | `DriverUnavailableError` |
| an `x:` code | `ExtensionCallError` |

Each tagged error has the call error's fields (`error.capability`,
`error.resetAt`, ...) and the call error itself (`error.callError`).
`toAriError(error)` turns it back into a throwable `AriError`, for Effect code
that implements a driver. `toTaggedError(value)` converts an `AriError` or call
error data. A rejection that is not a call error breaks the ARI contract, so it
becomes a defect, not a typed failure.

## Effect schemas

`ari/effect` exports one Effect schema per definition in `spec/v1`, named like
the root export's validators (`AriEventSchema`, `ThreadSchema`, ...). Each is
an `Effect.Schema.Codec` of the wire type from `ari`, so decoding gives
`AriEvent`, `Thread` and so on.

`scripts/codegen-effect.ts` generates them into `src/effect/generated/`;
`pnpm run codegen` runs it after the core codegen, and
`pnpm run codegen:effect:check` (a gate step) fails when they are stale. The
generator's header lists how each JSON Schema keyword becomes an Effect
schema. A shape it cannot translate exactly, such as an object `const`, fails
generation with a message naming the schema file.

The schemas accept exactly what the zero-dependency validators accept, and
they keep unknown fields when decoding, as ARI's forward-compatibility rule
requires. Committed tests compare the two on the 19 event variants, on
thousands of mutations of them, and on a synthetic schema that uses every
keyword. They differ in one place, and only for values JSON cannot carry: a
map entry whose value is `undefined` (for example `env: { PATH: undefined }`).
The validators skip it, as `JSON.stringify` drops it. The Effect schema
rejects it, because its decoded type says every map value is present.
