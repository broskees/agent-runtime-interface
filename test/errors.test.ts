// The eleven call errors keep their code and payload through JSON, the guard
// recognizes them, and the six failure classes carry code, retryable and resetAt.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AriError,
  CALL_ERROR_CODES,
  callErrors,
  FAILURE_CLASSES,
  FailureSchema,
  isAriError,
  isCallError,
  isFailure,
  toCallError,
} from "../src/index.ts";
import type { CallError, Failure, KnownCallErrorCode } from "../src/index.ts";

const ERRORS: ReadonlyArray<{ code: KnownCallErrorCode; error: AriError; payload: Record<string, unknown> }> = [
  { code: "unsupported", error: callErrors.unsupported("threads.fork"), payload: { capability: "threads.fork" } },
  { code: "invalid_state", error: callErrors.invalidState("previous_turn_active"), payload: { reason: "previous_turn_active" } },
  { code: "not_found", error: callErrors.notFound({ resource: "thread", id: "thread-9" }), payload: { resource: "thread", id: "thread-9" } },
  {
    code: "auth_required",
    error: callErrors.authRequired([{ id: "key", kind: "api_key", label: "API key", fields: [{ id: "key", label: "Key", secret: true }] }]),
    payload: { methods: [{ id: "key", kind: "api_key", label: "API key", fields: [{ id: "key", label: "Key", secret: true }] }] },
  },
  { code: "usage_limit", error: callErrors.usageLimit("2026-11-23T18:00:00Z"), payload: { resetAt: "2026-11-23T18:00:00Z" } },
  { code: "permission_denied", error: callErrors.permissionDenied("Denied by policy"), payload: {} },
  { code: "transport", error: callErrors.transport("The driver process exited"), payload: {} },
  { code: "protocol", error: callErrors.protocol("unexpected response id 7"), payload: { detail: "unexpected response id 7" } },
  {
    code: "validation",
    error: callErrors.validation([{ message: "Missing required field", path: ["body", "text"] }]),
    payload: { issues: [{ message: "Missing required field", path: ["body", "text"] }] },
  },
  { code: "attachment_unreadable", error: callErrors.attachmentUnreadable("att-3"), payload: { attachmentRef: "att-3" } },
  {
    code: "driver_unavailable",
    error: callErrors.driverUnavailable({ package: "@cursor/sdk", installHint: "npm install @cursor/sdk" }),
    payload: { package: "@cursor/sdk", installHint: "npm install @cursor/sdk" },
  },
];

describe("call errors", () => {
  test("there are exactly the eleven codes, each covered here", () => {
    assert.equal(CALL_ERROR_CODES.length, 11);
    assert.deepEqual(ERRORS.map((entry) => entry.code), [...CALL_ERROR_CODES]);
  });

  for (const { code, error, payload } of ERRORS) {
    test(`${code} survives JSON.stringify and JSON.parse with its code and payload`, () => {
      assert.ok(error instanceof Error);
      assert.equal(error.code, code);
      const parsed: unknown = JSON.parse(JSON.stringify(error));
      assert.equal(isCallError(parsed), true);
      assert.equal(isCallError(parsed, code), true);
      const callError = parsed as CallError;
      assert.equal(callError.code, code);
      assert.equal(callError.message, error.message);
      for (const [key, value] of Object.entries(payload)) {
        assert.deepEqual((callError as Record<string, unknown>)[key], value, `${code}.${key}`);
      }
      assert.deepEqual(parsed, error.toJSON());
      const otherCode = CALL_ERROR_CODES.find((candidate) => candidate !== code)!;
      assert.equal(isCallError(parsed, otherCode), false);
    });
  }

  test("the guard rejects lookalikes and payloads that break the schema", () => {
    assert.equal(isCallError({ code: "ENOENT", message: "no such file" }), false);
    assert.equal(isCallError({ code: "unsupported", message: "missing capability" }), false);
    assert.equal(isCallError({ code: "driver_unavailable", message: "names nothing to install" }), false);
    assert.equal(isCallError({ code: "usage_limit", message: "no reset", resetAt: 5 }), false);
    assert.equal(isCallError(null), false);
    assert.equal(isCallError("unsupported"), false);
  });

  test("a driver_unavailable error must name a package or a binary, in its type and at runtime", () => {
    // @ts-expect-error the type requires `package` or `binary`, as the schema does
    const incomplete: CallError = { code: "driver_unavailable", message: "Driver unavailable" };
    assert.throws(() => new AriError(incomplete), /Invalid call error.*package/);
    const withBinary: CallError = { code: "driver_unavailable", message: "Install pi", binary: "pi" };
    assert.equal(isCallError(JSON.parse(JSON.stringify(new AriError(withBinary))), "driver_unavailable"), true);
  });

  test("the AriError constructor refuses any payload that would fail its own round trip", () => {
    const fractionalPath = { code: "validation", message: "bad", issues: [{ message: "x", path: [1.5] }] } as CallError;
    assert.throws(() => new AriError(fractionalPath), /Invalid call error at issues\.0\.path\.0/);
    const missingCapability = { code: "unsupported", message: "no capability named" } as unknown as CallError;
    assert.throws(() => new AriError(missingCapability), /Invalid call error at capability/);
    const unknownCode = { code: "teapot", message: "short and stout" } as unknown as CallError;
    assert.throws(() => new AriError(unknownCode), TypeError);
    const extension: CallError = { code: "x:vendor.quota", message: "Vendor quota", data: { left: 0 } };
    assert.deepEqual(JSON.parse(JSON.stringify(new AriError(extension))), extension);
  });

  test("an optional field set to undefined is left out, as JSON.stringify leaves it out", () => {
    const viaBuilder = callErrors.notFound({ resource: "session", id: undefined });
    const viaConstructor = new AriError({ code: "transport", message: "Connection closed", retryable: undefined });
    const viaSpread = callErrors.driverUnavailable({ package: "@cursor/sdk", binary: undefined, installHint: undefined });
    const nestedMethod = callErrors.authRequired([{ id: "key", kind: "api_key", label: "API key", description: undefined, fields: undefined }]);
    const nestedIssue = callErrors.validation([{ message: "bad", path: undefined }]);
    const cases = [
      ["not_found", viaBuilder],
      ["transport", viaConstructor],
      ["driver_unavailable", viaSpread],
      ["auth_required", nestedMethod],
      ["validation", nestedIssue],
    ] as const;
    for (const [code, error] of cases) {
      const parsed: unknown = JSON.parse(JSON.stringify(error));
      assert.equal(isCallError(parsed, code), true, code);
      assert.deepEqual(error.callError, parsed, `${code}: the stored call error is exactly the wire form`);
      assert.equal(JSON.stringify(error.callError).length, JSON.stringify(parsed).length, code);
    }
    assert.deepEqual(nestedMethod.toJSON(), { code: "auth_required", message: "Sign-in required", methods: [{ id: "key", kind: "api_key", label: "API key" }] });
    assert.deepEqual(viaBuilder.toJSON(), { code: "not_found", message: "Not found: session", resource: "session" });
  });

  test("an extension error's data is kept in its wire form, and data JSON cannot carry is refused", () => {
    const dated = new AriError({ code: "x:vendor.quota", message: "Quota", data: { at: new Date(0), skipped: undefined } });
    assert.deepEqual(dated.callError, { code: "x:vendor.quota", message: "Quota", data: { at: "1970-01-01T00:00:00.000Z" } });
    assert.throws(() => new AriError({ code: "x:vendor.big", message: "Big", data: 1n }), /cannot be serialized as JSON/);
  });

  test("the guards treat an undefined optional field as absent but an undefined required field as missing", () => {
    const inProcess = { code: "transport", message: "Connection closed", retryable: undefined };
    assert.equal(isCallError(inProcess, "transport"), true);
    assert.deepEqual(toCallError(inProcess), inProcess);
    assert.equal(isCallError({ code: "unsupported", message: "x", capability: undefined }), false);
    assert.throws(() => new AriError({ code: "unsupported", message: "x", capability: undefined as unknown as string }), /Invalid call error at capability/);
  });

  test("a driver_unavailable payload missing both package and binary still throws, also when both are undefined", () => {
    assert.throws(() => new AriError({ code: "driver_unavailable", message: "x" } as unknown as CallError), /Invalid call error/);
    assert.throws(
      () => new AriError({ code: "driver_unavailable", message: "x", package: undefined, binary: undefined } as unknown as CallError),
      /Invalid call error/,
    );
  });

  test("an AriError converts back to data, and toCallError accepts both forms", () => {
    const error = callErrors.unsupported("turns.steer");
    assert.equal(isAriError(error, "unsupported"), true);
    assert.equal(isAriError(error, "transport"), false);
    assert.deepEqual(toCallError(error), { code: "unsupported", message: "Not supported: turns.steer", capability: "turns.steer" });
    assert.deepEqual(toCallError(JSON.parse(JSON.stringify(error))), toCallError(error));
    assert.equal(toCallError(new Error("plain")), undefined);
    const rebuilt = new AriError(toCallError(error)!);
    assert.equal(rebuilt.message, error.message);
  });
});

describe("failures", () => {
  test("there are exactly the six failure classes", () => {
    assert.deepEqual([...FAILURE_CLASSES], [
      "usage_limit",
      "provider_error",
      "transport_error",
      "permission_error",
      "validation_error",
      "unknown",
    ]);
  });

  for (const failureClass of FAILURE_CLASSES) {
    test(`a ${failureClass} failure with code, retryable and resetAt round-trips through JSON`, () => {
      const failure: Failure = {
        class: failureClass,
        message: `${failureClass} happened`,
        code: "E42",
        retryable: failureClass === "usage_limit",
        resetAt: "2026-11-23T18:00:00Z",
      };
      const parsed: unknown = JSON.parse(JSON.stringify(failure));
      assert.equal(isFailure(parsed), true);
      assert.deepEqual(parsed, failure);
    });
  }

  test("a failure without retryable is rejected", () => {
    assert.equal(FailureSchema.is({ class: "unknown", message: "x" }), false);
  });

  test("a failure whose optional fields are undefined is valid; an undefined retryable is not", () => {
    const failure: Failure = { class: "provider_error", message: "x", retryable: false, code: undefined, resetAt: undefined, detail: undefined };
    assert.equal(isFailure(failure), true);
    assert.equal(isFailure(JSON.parse(JSON.stringify(failure))), true);
    assert.equal(isFailure({ class: "provider_error", message: "x", retryable: undefined }), false);
  });
});
