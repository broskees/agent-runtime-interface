// The wire's method table is spec/v1/methods.json: same methods in the same
// order, with the same direction, kind, version and params schema, and the
// optional-member lists the descriptors use match the `optional` flags and
// capability gates there. A method added to methods.json fails this test
// until both ends of the wire serve it.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { OPTIONAL_HOST_MEMBERS, OPTIONAL_INSTANCE_MEMBERS, OPTIONAL_SESSION_MEMBERS, WIRE_METHODS } from "../../src/wire/index.ts";
import { STREAM_ITEM_NOTIFICATIONS } from "../../src/wire/methods.ts";
import { SPEC_DIR } from "../helpers/spec.ts";

interface MethodEntry {
  readonly name: string;
  readonly direction: string;
  readonly kind: string;
  readonly interface?: string;
  readonly member?: string;
  readonly optional?: boolean;
  readonly capability?: string;
  readonly params: { readonly $ref: string };
  readonly version: { readonly major: number; readonly minor: number };
  readonly stream?: { readonly notification: string };
}

const table = JSON.parse(fs.readFileSync(path.join(SPEC_DIR, "methods.json"), "utf8")) as { methods: MethodEntry[] };
const rpc = JSON.parse(fs.readFileSync(path.join(SPEC_DIR, "rpc.schema.json"), "utf8")) as { $defs: { [name: string]: any } };

test("WIRE_METHODS lists every method of methods.json with its direction, kind, version and params schema", () => {
  assert.deepEqual(
    WIRE_METHODS.map((method) => method.name),
    table.methods.map((method) => method.name),
  );
  for (const [index, entry] of table.methods.entries()) {
    const method = WIRE_METHODS[index]!;
    assert.equal(method.direction, entry.direction, `${entry.name}: direction`);
    assert.equal(method.kind, entry.kind, `${entry.name}: kind`);
    assert.deepEqual(method.version, entry.version, `${entry.name}: version`);
    assert.equal(method.params.schemaId, `https://ari.invalid/spec/v1/${entry.params.$ref}`, `${entry.name}: params schema`);
  }
});

test("the optional member lists match methods.json's optional flags and capability gates", () => {
  const optional = (name: string) => table.methods.filter((method) => method.interface === name && method.optional === true);
  assert.deepEqual([...OPTIONAL_INSTANCE_MEMBERS].sort(), optional("Instance").map((method) => method.member!).sort());
  assert.deepEqual(
    Object.entries(OPTIONAL_SESSION_MEMBERS).sort(),
    optional("Session").map((method) => [method.member!, method.capability!]).sort(),
  );
  assert.deepEqual([...OPTIONAL_HOST_MEMBERS].sort(), optional("HostServices").map((method) => method.member!).sort());
  assert.equal(OPTIONAL_INSTANCE_MEMBERS.length, 27);
  assert.equal(Object.keys(OPTIONAL_SESSION_MEMBERS).length, 17);
  // driver/create's hostMembers names the same members.
  assert.deepEqual([...rpc.$defs.OptionalHostMember.anyOf[0].enum].sort(), [...OPTIONAL_HOST_MEMBERS].sort());
});

test("every stream's item notification is routed, by a field its params require", () => {
  const notifications = table.methods.filter((method) => method.stream !== undefined).map((method) => method.stream!.notification);
  assert.deepEqual(Object.keys(STREAM_ITEM_NOTIFICATIONS).sort(), [...new Set(notifications)].sort());
  for (const [notification, field] of Object.entries(STREAM_ITEM_NOTIFICATIONS)) {
    const entry = table.methods.find((method) => method.name === notification)!;
    const schema = rpc.$defs[entry.params.$ref.split("/").pop()!];
    assert.deepEqual(schema.required, ["streamId", field], `${notification} carries its item in ${field}`);
  }
});
