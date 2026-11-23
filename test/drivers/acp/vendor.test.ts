// The ACP clients are generated from ACP's own schemas, vendored at a pinned
// release: the vendored files match test/drivers/acp/SOURCES.md and the files
// the pinned SDK devDependency ships, the generated types cover every method
// the schemas define, the drift check catches a changed schema, and the frame
// checker the conformance runs use rejects a frame that breaks the schema.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { ACP_SCHEMA_RELEASE, findDrift, generate } from "../../../scripts/codegen-acp.ts";
import type { AcpConnection } from "../../../src/drivers/acp/index.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { checkFrames } from "./frames.ts";

const VENDOR = path.join(REPO_ROOT, "vendor-schemas", "acp", ACP_SCHEMA_RELEASE);
const SOURCES = fs.readFileSync(path.join(REPO_ROOT, "test", "drivers", "acp", "SOURCES.md"), "utf8");
const tempDirs: string[] = [];
after(() => {
  for (const directory of tempDirs) fs.rmSync(directory, { recursive: true, force: true });
});

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("the vendored schema files are the ones SOURCES.md pins, byte for byte", () => {
  assert.ok(SOURCES.includes(`release \`${ACP_SCHEMA_RELEASE}\``), "SOURCES.md names the vendored release");
  const rows = [...SOURCES.matchAll(/^\| (v[12]\/schema(?:\.unstable)?\.json) \| ([0-9a-f]{64}) \|$/gm)];
  assert.equal(rows.length, 4);
  for (const [, file, digest] of rows) assert.equal(sha256(path.join(VENDOR, file!)), digest, file);
});

test("the pinned SDK devDependency is the version SOURCES.md names, and ships the same schema files", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { devDependencies: { [name: string]: string } };
  const pinned = pkg.devDependencies["@agentclientprotocol/sdk"];
  assert.match(pinned ?? "", /^\d+\.\d+\.\d+$/, "pinned to an exact version");
  assert.ok(SOURCES.includes(`\`@agentclientprotocol/sdk\` **${pinned}**`), `SOURCES.md names @agentclientprotocol/sdk ${pinned}`);
  assert.ok(SOURCES.includes(`\`zod\` **${pkg.devDependencies["zod"]}**`), "SOURCES.md names the zod peer version");
  const installed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "node_modules", "@agentclientprotocol", "sdk", "package.json"), "utf8")) as { version: string };
  assert.equal(installed.version, pinned);
  for (const file of ["v1/schema.json", "v1/schema.unstable.json", "v2/schema.json", "v2/schema.unstable.json"]) {
    assert.equal(sha256(path.join(REPO_ROOT, "node_modules", "@agentclientprotocol", "sdk", "schema", file)), sha256(path.join(VENDOR, file)), file);
  }
});

test("the committed generated clients match the vendored schemas, with a method table for every method they define", () => {
  assert.deepEqual(findDrift(REPO_ROOT), []);
  const outputs = generate(REPO_ROOT);
  for (const version of [1, 2]) {
    const generated = outputs.get(`src/drivers/acp/generated/v${version}.ts`)!;
    const schema = JSON.parse(fs.readFileSync(path.join(VENDOR, `v${version}`, "schema.unstable.json"), "utf8")) as { $defs: { [name: string]: { "x-method"?: string } } };
    const methods = new Set(Object.values(schema.$defs).flatMap((definition) => (definition["x-method"] === undefined ? [] : [definition["x-method"]])));
    for (const method of methods) assert.ok(generated.includes(`${JSON.stringify(method)}:`), `v${version} has no table entry for ${method}`);
    assert.match(generated, /"session\/prompt": \{ params: PromptRequest; result: PromptResponse \}/);
    assert.match(generated, /"session\/fork": \{ params: ForkSessionRequest; result: ForkSessionResponse \}/);
  }
});

test("the driver's requests are typed by the generated tables", () => {
  // Compile-time checks: a method or a field the ACP schema does not define does not compile.
  const typed = (connection: AcpConnection): void => {
    void connection.requestV2("session/prompt", { sessionId: "s", prompt: [{ type: "text", text: "hi" }] });
    // @ts-expect-error session/load is a v1 method; ACP v2 removed it.
    void connection.requestV2("session/load", { sessionId: "s", cwd: "/", mcpServers: [] });
    // @ts-expect-error a v1 prompt needs its prompt blocks.
    void connection.requestV1("session/prompt", { sessionId: "s" });
  };
  assert.equal(typeof typed, "function");
});

test("codegen:acp --check fails after one vendored schema changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ari-codegen-acp-"));
  tempDirs.push(root);
  fs.cpSync(path.join(REPO_ROOT, "vendor-schemas"), path.join(root, "vendor-schemas"), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, "src", "drivers", "acp", "generated"), path.join(root, "src", "drivers", "acp", "generated"), { recursive: true });
  const script = path.join(REPO_ROOT, "scripts", "codegen-acp.ts");
  const run = (): { status: number | null; stderr: string } => {
    const result = spawnSync(process.execPath, [script, "--check", "--root", root], { encoding: "utf8" });
    return { status: result.status, stderr: result.stderr };
  };
  assert.equal(run().status, 0);
  const file = path.join(root, "vendor-schemas", "acp", ACP_SCHEMA_RELEASE, "v2", "schema.unstable.json");
  const schema = JSON.parse(fs.readFileSync(file, "utf8")) as { $defs: { PromptResponse: { properties: { [name: string]: unknown } } } };
  schema.$defs.PromptResponse.properties["turnId"] = { type: "string" };
  fs.writeFileSync(file, JSON.stringify(schema));
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/drivers\/acp\/generated\/v2\.ts differs from the vendored ACP schema/);
});

test("the frame checker rejects frames that break ACP's schema", () => {
  const good = [
    { connection: 1, from: "client" as const, message: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } } },
    { connection: 1, from: "agent" as const, message: { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } } },
    { connection: 1, from: "client" as const, message: { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "hi" }] } } },
  ];
  assert.deepEqual(checkFrames(good).problems, []);
  const bad = [...good.slice(0, 2), { connection: 1, from: "client" as const, message: { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "s", prompt: "hi" } } }];
  assert.match(checkFrames(bad).problems.join("\n"), /session\/prompt request breaks v1 PromptRequest/);
  const unknown = [...good.slice(0, 2), { connection: 1, from: "client" as const, message: { jsonrpc: "2.0", id: 3, method: "session/teleport", params: {} } }];
  assert.match(checkFrames(unknown).problems.join("\n"), /defines no request session\/teleport/);
  const wrongResult = [...good, { connection: 1, from: "agent" as const, message: { jsonrpc: "2.0", id: 2, result: { stopReason: "finished-ish" } } }];
  assert.match(checkFrames(wrongResult).problems.join("\n"), /session\/prompt response breaks v1 PromptResponse/);
});
