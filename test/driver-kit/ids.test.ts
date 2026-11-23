// Deterministic ids: the same kind, native input and identityVersion give the
// same id in two separate Node processes; a new identityVersion gives a new
// id; weak and none references derive from ordinal plus fingerprint.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, test } from "node:test";
import { OrdinalCounter, canonicalJson, contentFingerprint, deriveId, sha256Hex } from "../../src/driver-kit/index.ts";
import type { DeriveIdInput } from "../../src/driver-kit/index.ts";
import { REPO_ROOT } from "../helpers/spec.ts";

const run = promisify(execFile);

const INPUTS: DeriveIdInput[] = [
  { kind: "thread", native: { id: "thr_123", strength: "strong" }, identityVersion: 1 },
  { kind: "turn", native: { id: "turn-7", strength: "weak", ordinal: 3 }, identityVersion: 1, scope: "thread_abc" },
  { kind: "item", native: { id: null, strength: "none", ordinal: 0, fingerprint: "f00d" }, identityVersion: 2, scope: "turn_def" },
  { kind: "request", native: { id: "perm-1", strength: "weak", fingerprint: "abc" }, identityVersion: 0, scope: "turn_def" },
];

/** Derives every input in a fresh Node process. */
async function deriveInChildProcess(): Promise<string[]> {
  const moduleUrl = pathToFileURL(path.join(REPO_ROOT, "src", "driver-kit", "ids.ts")).href;
  const script = [
    `const { deriveId } = await import(${JSON.stringify(moduleUrl)});`,
    `const inputs = ${JSON.stringify(INPUTS)};`,
    "console.log(JSON.stringify(inputs.map((input) => deriveId(input))));",
  ].join("\n");
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: REPO_ROOT });
  return JSON.parse(stdout) as string[];
}

describe("deterministic ids", () => {
  test("the same kind, native input and identityVersion give the same id in two separate Node processes", async () => {
    const [first, second] = await Promise.all([deriveInChildProcess(), deriveInChildProcess()]);
    assert.deepEqual(first, second);
    assert.deepEqual(first, INPUTS.map((input) => deriveId(input)));
    assert.equal(new Set(first).size, INPUTS.length);
    for (const [index, id] of first.entries()) assert.match(id, new RegExp(`^${INPUTS[index]!.kind}_[0-9a-f]{32}$`));
  });

  test("a different identityVersion gives a different id", () => {
    for (const input of INPUTS) {
      assert.notEqual(deriveId({ ...input, identityVersion: input.identityVersion + 1 }), deriveId(input));
    }
  });

  test("strong references use the native id alone; scope and kind still separate ids", () => {
    const base: DeriveIdInput = { kind: "item", native: { id: "x", strength: "strong" }, identityVersion: 1, scope: "turn-1" };
    assert.equal(deriveId({ ...base, native: { id: "x", strength: "strong", ordinal: 9, fingerprint: "zz" } }), deriveId(base));
    assert.notEqual(deriveId({ ...base, native: { id: "y", strength: "strong" } }), deriveId(base));
    assert.notEqual(deriveId({ ...base, scope: "turn-2" }), deriveId(base));
    assert.notEqual(deriveId({ ...base, kind: "request" }), deriveId(base));
  });

  test("weak and none references derive from ordinal plus fingerprint", () => {
    const fingerprint = contentFingerprint({ role: "assistant", text: "Hello" });
    const none = (ordinal: number, print?: string): string =>
      deriveId({ kind: "item", native: { id: null, strength: "none", ordinal, ...(print === undefined ? {} : { fingerprint: print }) }, identityVersion: 1, scope: "turn-1" });
    assert.equal(none(0, fingerprint), none(0, fingerprint));
    assert.notEqual(none(0, fingerprint), none(1, fingerprint));
    assert.notEqual(none(0, fingerprint), none(0, contentFingerprint({ role: "assistant", text: "Bye" })));
    assert.notEqual(none(0, fingerprint), none(0));

    const weak = (id: string | null, ordinal?: number, print?: string): string =>
      deriveId({
        kind: "request",
        native: { id, strength: "weak", ...(ordinal === undefined ? {} : { ordinal }), ...(print === undefined ? {} : { fingerprint: print }) },
        identityVersion: 1,
        scope: "turn-1",
      });
    assert.equal(weak("p", 0, fingerprint), weak("p", 0, fingerprint));
    assert.notEqual(weak("p", 0, fingerprint), weak("p", 1, fingerprint));
    assert.notEqual(weak("p", 0, fingerprint), weak("p", 0, "other"));
    assert.notEqual(weak("p", 0), weak("q", 0));
  });

  test("references that miss what their strength needs are refused", () => {
    assert.throws(() => deriveId({ kind: "item", native: { id: null, strength: "strong" }, identityVersion: 1 }), TypeError);
    assert.throws(() => deriveId({ kind: "item", native: { id: "x", strength: "weak" }, identityVersion: 1 }), TypeError);
    assert.throws(() => deriveId({ kind: "item", native: { id: null, strength: "none", fingerprint: "f" }, identityVersion: 1 }), TypeError);
    assert.throws(() => deriveId({ kind: "item", native: { id: "x", strength: "sometimes" }, identityVersion: 1 }), TypeError);
    assert.throws(() => deriveId({ kind: "item", native: { id: "x", strength: "strong" }, identityVersion: -1 }), TypeError);
  });

  test("content fingerprints ignore key order and undefined fields", () => {
    assert.equal(canonicalJson({ b: 1, a: [true, null, { d: "x", c: undefined }] }), '{"a":[true,null,{"d":"x"}],"b":1}');
    assert.equal(contentFingerprint({ a: 1, b: 2 }), contentFingerprint({ b: 2, a: 1 }));
    assert.notEqual(contentFingerprint({ a: 1 }), contentFingerprint({ a: 2 }));
  });

  test("ordinals count per scope", () => {
    const ordinals = new OrdinalCounter();
    assert.deepEqual([ordinals.next("turn-1"), ordinals.next("turn-1"), ordinals.next("turn-2"), ordinals.next("turn-1")], [0, 1, 0, 2]);
  });

  test("the built-in SHA-256 matches node:crypto", () => {
    const samples = ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(1000), "héllo wörld ✓ 🎉", "\u0000￿"];
    for (let length = 0; length < 300; length += 7) samples.push(String.fromCharCode(...Array.from({ length }, (_unused, index) => 32 + ((index * 31) % 90))));
    for (const sample of samples) {
      assert.equal(sha256Hex(sample), createHash("sha256").update(sample, "utf8").digest("hex"), JSON.stringify(sample));
    }
  });
});
