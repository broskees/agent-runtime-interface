// The protocol words the sanitiser keeps are exactly what the pinned sources
// allow: the Claude words what the pinned SDK's declarations allow
// (test/recordings/claude/protocol-words.ts), the OpenCode words what the pinned
// client's declarations allow, and the ACP words what the vendored ACP schemas
// allow. docs/recordings.md names every key of each.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "../helpers/spec.ts";
import { CLAUDE_SDK_DECLARATIONS, deriveClaudeProtocolWords } from "./claude/derive-protocol-words.ts";
import { CLAUDE_PROTOCOL_WORDS } from "./claude/protocol-words.ts";
import { ACP_SCHEMA_DIRECTORY, deriveAcpProtocolWords } from "./acp/derive-protocol-words.ts";
import { ACP_PROTOCOL_WORDS } from "./acp/protocol-words.ts";
import { OPENCODE_CLIENT_DECLARATIONS, deriveOpencodeProtocolWords } from "./opencode/derive-protocol-words.ts";
import { OPENCODE_PROTOCOL_WORDS } from "./opencode/protocol-words.ts";

test("the committed Claude protocol words equal what the pinned sdk.d.ts allows, key by key", () => {
  assert.ok(fs.existsSync(CLAUDE_SDK_DECLARATIONS), CLAUDE_SDK_DECLARATIONS);
  const pinned = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), "utf8")) as { version: string };
  assert.equal(pinned.version, "0.3.330", "the words were derived from the pinned SDK 0.3.330");
  const derived = deriveClaudeProtocolWords();
  assert.deepEqual(
    Object.keys(CLAUDE_PROTOCOL_WORDS),
    Object.keys(derived),
    "the keys (run `node test/recordings/claude/derive-protocol-words.ts` to see the derivation)",
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(CLAUDE_PROTOCOL_WORDS).map(([key, words]) => [key, [...words]])),
    derived,
  );
});

test("the protocol words hold the discriminants an account named like them would otherwise break", () => {
  for (const word of ["user", "assistant", "system"]) {
    assert.ok(CLAUDE_PROTOCOL_WORDS["type"]!.includes(word), `type: ${word}`);
    assert.ok(CLAUDE_PROTOCOL_WORDS["role"]!.includes(word), `role: ${word}`);
  }
  assert.ok(CLAUDE_PROTOCOL_WORDS["apiKeySource"]!.includes("user"));
  assert.ok(CLAUDE_PROTOCOL_WORDS["subtype"]!.includes("init"));
  assert.ok(CLAUDE_PROTOCOL_WORDS["permissionMode"]!.includes("default"));
  // Free-text keys are not protocol keys, so a user name there is replaced.
  for (const key of ["text", "stdout", "stderr", "content", "data", "command"]) assert.equal(CLAUDE_PROTOCOL_WORDS[key], undefined, key);
});

test("docs/recordings.md names every Claude protocol key and says where the words come from", () => {
  const docs = fs.readFileSync(path.join(REPO_ROOT, "docs", "recordings.md"), "utf8");
  const start = docs.indexOf("### Claude protocol words");
  assert.notEqual(start, -1, 'docs/recordings.md has a section "Claude protocol words"');
  const section = docs.slice(start, docs.indexOf("\n## ", start) === -1 ? undefined : docs.indexOf("\n## ", start));
  assert.match(section, /sdk\.d\.ts/);
  const named = [...section.matchAll(/`([A-Za-z_]+)`/g)].map((match) => match[1]!);
  for (const key of Object.keys(CLAUDE_PROTOCOL_WORDS)) assert.ok(named.includes(key), `the docs name ${key}`);
});

test("the committed OpenCode protocol words equal what the pinned @opencode/client declarations allow, key by key", () => {
  assert.ok(fs.existsSync(OPENCODE_CLIENT_DECLARATIONS), OPENCODE_CLIENT_DECLARATIONS);
  const pinned = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "node_modules", "@opencode", "client", "package.json"), "utf8")) as { version: string };
  assert.equal(pinned.version, "2.1.2", "the words were derived from the pinned @opencode/client 2.1.2");
  const derived = deriveOpencodeProtocolWords();
  assert.deepEqual(
    Object.keys(OPENCODE_PROTOCOL_WORDS),
    Object.keys(derived),
    "the keys (run `node test/recordings/opencode/derive-protocol-words.ts` to see the derivation)",
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(OPENCODE_PROTOCOL_WORDS).map(([key, words]) => [key, [...words]])),
    derived,
  );
});

test("the OpenCode protocol words hold the discriminants an account named like them would otherwise break", () => {
  for (const word of ["user", "assistant", "text", "tool", "reasoning", "server.connected", "session.text.delta", "session.execution.succeeded", "permission.asked"]) {
    assert.ok(OPENCODE_PROTOCOL_WORDS["type"]!.includes(word), `type: ${word}`);
  }
  assert.deepEqual([...OPENCODE_PROTOCOL_WORDS["effect"]!], ["allow", "ask", "deny"]);
  assert.ok(OPENCODE_PROTOCOL_WORDS["_tag"]!.includes("SessionNotFoundError"));
  // Free-text keys are not protocol keys, so a user name there is replaced.
  for (const key of ["text", "delta", "content", "message", "title", "directory"]) assert.equal(OPENCODE_PROTOCOL_WORDS[key], undefined, key);
});

test("docs/recordings.md names every OpenCode protocol key and says where the words come from", () => {
  const docs = fs.readFileSync(path.join(REPO_ROOT, "docs", "recordings.md"), "utf8");
  const start = docs.indexOf("### OpenCode protocol words");
  assert.notEqual(start, -1, 'docs/recordings.md has a section "OpenCode protocol words"');
  const section = docs.slice(start, docs.indexOf("\n## ", start) === -1 ? undefined : docs.indexOf("\n## ", start));
  assert.match(section, /@opencode\/client\/dist\/promise\/index\.d\.ts/);
  const named = [...section.matchAll(/`([A-Za-z_]+)`/g)].map((match) => match[1]!);
  for (const key of Object.keys(OPENCODE_PROTOCOL_WORDS)) assert.ok(named.includes(key), `the docs name ${key}`);
});

test("the committed ACP protocol words equal what the vendored ACP schemas allow, key by key", () => {
  assert.equal(path.relative(REPO_ROOT, ACP_SCHEMA_DIRECTORY).split(path.sep).join("/"), "vendor-schemas/acp/schema-v2.0.0-beta.3", "the release the ACP drivers are built on");
  for (const version of ["v1", "v2"]) assert.ok(fs.existsSync(path.join(ACP_SCHEMA_DIRECTORY, version, "schema.unstable.json")), version);
  const derived = deriveAcpProtocolWords();
  assert.deepEqual(Object.keys(ACP_PROTOCOL_WORDS), Object.keys(derived), "the keys (run `node test/recordings/acp/derive-protocol-words.ts` to see the derivation)");
  assert.deepEqual(
    Object.fromEntries(Object.entries(ACP_PROTOCOL_WORDS).map(([key, words]) => [key, [...words]])),
    derived,
  );
});

test("the ACP protocol word derivation fails on a schema that drifts: a new enum value or a new method appears in the derivation", () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "ari-acp-schema-"));
  try {
    for (const version of ["v1", "v2"]) {
      fs.mkdirSync(path.join(copy, version));
      for (const file of ["schema.unstable.json", "meta.unstable.json"]) fs.copyFileSync(path.join(ACP_SCHEMA_DIRECTORY, version, file), path.join(copy, version, file));
    }
    const schema = JSON.parse(fs.readFileSync(path.join(copy, "v1", "schema.unstable.json"), "utf8")) as { $defs: { [name: string]: { oneOf?: Array<{ const?: string }>; enum?: string[] } } };
    const stopReason = schema.$defs["StopReason"]!;
    if (stopReason.oneOf !== undefined) stopReason.oneOf.push({ const: "drifted_stop_reason" });
    else stopReason.enum!.push("drifted_stop_reason");
    fs.writeFileSync(path.join(copy, "v1", "schema.unstable.json"), JSON.stringify(schema));
    const meta = JSON.parse(fs.readFileSync(path.join(copy, "v2", "meta.unstable.json"), "utf8")) as { clientMethods: { [name: string]: string } };
    meta.clientMethods["drifted"] = "drifted/method";
    fs.writeFileSync(path.join(copy, "v2", "meta.unstable.json"), JSON.stringify(meta));
    const drifted = deriveAcpProtocolWords(copy);
    assert.ok(drifted["stopReason"]!.includes("drifted_stop_reason"));
    assert.ok(drifted["method"]!.includes("drifted/method"));
    assert.notDeepEqual(drifted, Object.fromEntries(Object.entries(ACP_PROTOCOL_WORDS).map(([key, words]) => [key, [...words]])), "the committed words no longer equal the derivation");
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test("the ACP protocol words hold the discriminants an account named like them would otherwise break", () => {
  for (const word of ["text", "tool_call", "content", "diff"]) assert.ok(ACP_PROTOCOL_WORDS["type"]!.includes(word), `type: ${word}`);
  for (const word of ["agent_message_chunk", "tool_call_update", "config_option_update", "usage_update"]) assert.ok(ACP_PROTOCOL_WORDS["sessionUpdate"]!.includes(word), `sessionUpdate: ${word}`);
  for (const word of ["allow_once", "reject_once", "execute"]) assert.ok(ACP_PROTOCOL_WORDS["kind"]!.includes(word), `kind: ${word}`);
  for (const word of ["session/update", "session/request_permission"]) assert.ok(ACP_PROTOCOL_WORDS["method"]!.includes(word), `method: ${word}`);
  assert.ok(ACP_PROTOCOL_WORDS["category"]!.includes("model"));
  assert.deepEqual([...ACP_PROTOCOL_WORDS["jsonrpc"]!], ["2.0"]);
  // Free-text keys are not protocol keys, so a user name there is replaced.
  for (const key of ["text", "title", "name", "message", "sessionId", "cwd", "description"]) assert.equal(ACP_PROTOCOL_WORDS[key], undefined, key);
});

test("docs/recordings.md names every ACP protocol key and says where the words come from", () => {
  const docs = fs.readFileSync(path.join(REPO_ROOT, "docs", "recordings.md"), "utf8");
  const start = docs.indexOf("### ACP protocol words");
  assert.notEqual(start, -1, 'docs/recordings.md has a section "ACP protocol words"');
  const section = docs.slice(start, docs.indexOf("\n## ", start) === -1 ? undefined : docs.indexOf("\n## ", start));
  assert.match(section, /vendor-schemas\/acp\/schema-v2\.0\.0-beta\.3/);
  const named = [...section.matchAll(/`([A-Za-z_]+)`/g)].map((match) => match[1]!);
  for (const key of Object.keys(ACP_PROTOCOL_WORDS)) assert.ok(named.includes(key), `the docs name ${key}`);
});
