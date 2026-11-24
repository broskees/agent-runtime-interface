// The Rust, Python and Go clients' wire types are generated from json-schema/
// and spec/v1/methods.json, and `pnpm run codegen:clients:check` (a gate step)
// fails when a committed generated file no longer matches them. This test runs
// the check on a copy of the inputs and outputs: it passes as committed, and it
// names all three generated files once a schema or a method changes, or when a
// generated file is gone.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { findClientDrift, generateClients } from "../../clients/codegen/index.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GENERATED = ["clients/rust/src/generated.rs", "clients/python/src/ari_client/_generated.py", "clients/go/generated.go"];

const temporary: string[] = [];
after(() => {
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
});

/** A temp root holding json-schema/, spec/v1/methods.json and the committed generated files. */
function copyOfInputsAndOutputs(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ari-clients-codegen-"));
  temporary.push(root);
  fs.cpSync(path.join(ROOT, "json-schema"), path.join(root, "json-schema"), { recursive: true });
  fs.mkdirSync(path.join(root, "spec", "v1"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "spec", "v1", "methods.json"), path.join(root, "spec", "v1", "methods.json"));
  for (const relative of GENERATED) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), path.join(root, relative));
  }
  return root;
}

test("the committed client files match what json-schema/ and methods.json generate", () => {
  assert.deepEqual([...generateClients(ROOT).keys()].sort(), [...GENERATED].sort());
  assert.deepEqual(findClientDrift(ROOT), []);
  assert.deepEqual(findClientDrift(copyOfInputsAndOutputs()), []);
});

test("a changed schema makes the drift check name every client", () => {
  const root = copyOfInputsAndOutputs();
  const file = path.join(root, "json-schema", "events.schema.json");
  const schema = JSON.parse(fs.readFileSync(file, "utf8"));
  schema.$defs.TurnTerminalStatus.anyOf[0].enum.push("paused");
  fs.writeFileSync(file, JSON.stringify(schema, null, 2));
  assert.deepEqual(findClientDrift(root), GENERATED.map((relative) => `${relative} differs from json-schema/ and spec/v1/methods.json`));
  // The new value reaches each language.
  const outputs = generateClients(root);
  assert.match(outputs.get("clients/rust/src/generated.rs")!, /Paused = "paused",/);
  assert.match(outputs.get("clients/python/src/ari_client/_generated.py")!, /PAUSED = "paused"/);
  assert.match(outputs.get("clients/go/generated.go")!, /TurnTerminalStatusPaused\s+TurnTerminalStatus = "paused"/);
});

test("a changed method version makes the drift check name every client", () => {
  const root = copyOfInputsAndOutputs();
  const file = path.join(root, "spec", "v1", "methods.json");
  const table = JSON.parse(fs.readFileSync(file, "utf8"));
  table.methods.find((method: { name: string }) => method.name === "session/startTurn").version.minor = 1;
  fs.writeFileSync(file, JSON.stringify(table, null, 2));
  assert.deepEqual(findClientDrift(root), GENERATED.map((relative) => `${relative} differs from json-schema/ and spec/v1/methods.json`));
});

test("a missing generated file is drift", () => {
  const root = copyOfInputsAndOutputs();
  fs.rmSync(path.join(root, "clients/go/generated.go"));
  assert.deepEqual(findClientDrift(root), ["clients/go/generated.go is missing"]);
});
