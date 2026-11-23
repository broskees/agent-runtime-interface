// The Codex protocol client is generated from the vendored app-server schema,
// the gate's drift check catches a stale client, the vendored files are the
// ones SOURCES.md records, and the frame validator the fake uses rejects
// frames the schema does not allow.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { CLIENT_REQUESTS, CODEX_SOURCE, OUTPUT_FILE, SCHEMA_FILE, SERVER_NOTIFICATIONS, SERVER_REQUESTS, generateCodexProtocol } from "../../../scripts/codegen-codex.ts";
import { CODEX_PROTOCOL_SOURCE } from "../../../src/drivers/codex/index.ts";
import { CodexAppServerClient, CODEX_CLIENT_REQUEST_METHODS, CODEX_SERVER_NOTIFICATION_METHODS, CODEX_SERVER_REQUEST_METHODS } from "../../../src/drivers/codex/generated/protocol.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { CODEX_SCHEMA_DIR, CodexFrameValidator } from "./schema-validator.ts";

const GENERATOR = path.join(REPO_ROOT, "scripts", "codegen-codex.ts");
const temporary: string[] = [];
after(() => {
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
});

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

describe("the generated Codex client", () => {
  test("the committed client is what the vendored schema generates", () => {
    assert.equal(fs.readFileSync(path.join(REPO_ROOT, OUTPUT_FILE), "utf8"), generateCodexProtocol(CODEX_SCHEMA_DIR));
    assert.deepEqual(CODEX_PROTOCOL_SOURCE, CODEX_SOURCE);
  });

  test("--check passes on the vendored schema and fails when the schema changes", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ari-codex-codegen-"));
    temporary.push(directory);
    const schemaDir = path.join(directory, "schema");
    fs.cpSync(CODEX_SCHEMA_DIR, schemaDir, { recursive: true });
    const out = path.join(directory, "protocol.ts");
    fs.copyFileSync(path.join(REPO_ROOT, OUTPUT_FILE), out);
    const run = () => spawnSync(process.execPath, [GENERATOR, "--check", "--schema-dir", schemaDir, "--out", out], { encoding: "utf8" });
    assert.equal(run().status, 0, run().stderr);

    const schemaPath = path.join(schemaDir, SCHEMA_FILE);
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    schema.definitions.v2.TurnSteerParams.properties.expectedTurnId = { type: "integer" };
    fs.writeFileSync(schemaPath, JSON.stringify(schema));
    const drifted = run();
    assert.equal(drifted.status, 1);
    assert.match(drifted.stderr, /differs from what the vendored Codex schema generates/);
  });

  test("the generator refuses a method the schema does not have", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ari-codex-codegen-"));
    temporary.push(directory);
    fs.cpSync(CODEX_SCHEMA_DIR, directory, { recursive: true });
    const schemaPath = path.join(directory, SCHEMA_FILE);
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    schema.definitions.ClientRequest.oneOf = schema.definitions.ClientRequest.oneOf.filter((variant: { properties: { method: { enum: string[] } } }) => variant.properties.method.enum[0] !== "turn/steer");
    fs.writeFileSync(schemaPath, JSON.stringify(schema));
    assert.throws(() => generateCodexProtocol(directory), /ClientRequest has no method turn\/steer/);
  });

  test("the client has one method per client request, and each sends that method", async () => {
    assert.deepEqual([...CODEX_CLIENT_REQUEST_METHODS], [...CLIENT_REQUESTS]);
    assert.deepEqual([...CODEX_SERVER_REQUEST_METHODS], [...SERVER_REQUESTS]);
    assert.deepEqual([...CODEX_SERVER_NOTIFICATION_METHODS], [...SERVER_NOTIFICATIONS]);
    const sent: Array<{ method: string; params: unknown }> = [];
    const client = new CodexAppServerClient({
      request: async (method, params) => {
        sent.push({ method, params });
        return {};
      },
      notify: async () => undefined,
    });
    for (const method of CLIENT_REQUESTS) {
      const name = method
        .split(/[/_]/)
        .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
        .join("");
      const call = (client as unknown as { [key: string]: (params: unknown) => Promise<unknown> })[name];
      assert.equal(typeof call, "function", `the client has no ${name} for ${method}`);
      await call!.call(client, { probe: method });
    }
    assert.deepEqual(
      sent.map((entry) => entry.method),
      [...CLIENT_REQUESTS],
    );
  });
});

describe("the vendored Codex schema", () => {
  test("the vendored files are the ones both SOURCES.md files record, at the pinned commit", () => {
    const vendorSources = fs.readFileSync(path.join(CODEX_SCHEMA_DIR, "SOURCES.md"), "utf8");
    const testSources = fs.readFileSync(path.join(import.meta.dirname, "SOURCES.md"), "utf8");
    assert.equal(path.basename(CODEX_SCHEMA_DIR), CODEX_SOURCE.commit);
    for (const file of [SCHEMA_FILE, "app-server-README.md", "hand-written-additions.json"]) {
      const hash = sha256(path.join(CODEX_SCHEMA_DIR, file));
      assert.ok(vendorSources.includes(hash), `vendor SOURCES.md does not record ${file} with sha256 ${hash}`);
    }
    assert.ok(testSources.includes(sha256(path.join(CODEX_SCHEMA_DIR, SCHEMA_FILE))), "test SOURCES.md does not record the vendored schema's hash");
    for (const sources of [vendorSources, testSources]) {
      assert.ok(sources.includes(CODEX_SOURCE.commit));
      assert.ok(sources.includes(CODEX_SOURCE.tag));
    }
  });

  test("the hand-written additions are marked as hand-written", () => {
    const additions = JSON.parse(fs.readFileSync(path.join(CODEX_SCHEMA_DIR, "hand-written-additions.json"), "utf8"));
    assert.match(additions.$comment, /^HAND-WRITTEN/);
  });
});

describe("the frame validator the fake uses", () => {
  test("accepts valid frames and rejects frames the schema does not allow, naming the field", () => {
    const validator = new CodexFrameValidator();
    assert.equal(validator.checkCall("to_codex", { id: 1, method: "turn/steer", params: { threadId: "t", expectedTurnId: "turn", input: [{ type: "text", text: "Also add tests." }] } }), true);
    assert.equal(validator.checkCall("to_codex", { id: 2, method: "turn/steer", params: { threadId: "t", input: [] } }), false);
    assert.match(validator.problems.at(-1)!.message, /expectedTurnId/);
    assert.equal(validator.checkCall("from_codex", { method: "turn/started", params: { threadId: "t", turn: { id: "x" } } }), false);
    assert.equal(validator.checkCall("from_codex", { method: "thread/notAMethod", params: {} }), false);
    assert.match(validator.problems.at(-1)!.message, /not a ServerNotification method/);
    assert.equal(validator.checkResponse("from_codex", { id: 3, result: { turnId: 7 } }, "turn/steer"), false);
    assert.equal(validator.checkResponse("to_codex", { id: 0, result: { decision: "acceptForSession" } }, "item/commandExecution/requestApproval"), true);
    assert.equal(validator.checkResponse("to_codex", { id: 0, result: { decision: "always" } }, "item/commandExecution/requestApproval"), false);
    assert.equal(validator.checkResponse("from_codex", { id: 4, error: { code: -32600, message: "no active turn to steer" } }, "turn/steer"), true);
  });
});
