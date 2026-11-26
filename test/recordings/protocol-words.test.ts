// The protocol words the sanitiser keeps are exactly what the pinned sources
// allow, at the places they allow them (./protocol-places.ts): the Claude
// words what the pinned SDK's declarations allow, the OpenCode words what the
// pinned client's declarations allow, the ACP words what the vendored ACP
// schemas allow, and the Codex words what the vendored Codex app-server schema
// allows. docs/recordings.md names every key of each.

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
import { CODEX_SCHEMA_DIRECTORY, deriveCodexProtocolWords } from "./codex/derive-protocol-words.ts";
import { CODEX_PROTOCOL_WORDS } from "./codex/protocol-words.ts";
import { FRAME_PLACE, isProtocolWordAt, protocolKeys } from "./protocol-places.ts";
import type { ProtocolWords } from "./protocol-places.ts";

/** The committed words as plain JSON, to compare with a derivation. */
function plain(words: ProtocolWords): unknown {
  return JSON.parse(JSON.stringify(words));
}

/** Every place a committed table names exists in it, and the frame's place is there: the table is whole. */
function assertWhole(words: ProtocolWords, label: string): void {
  assert.ok(words[FRAME_PLACE] !== undefined, `${label}: the frame's place`);
  for (const [place, slots] of Object.entries(words)) {
    for (const [key, slot] of Object.entries(slots)) {
      if (slot.place !== undefined) assert.ok(words[slot.place] !== undefined, `${label}: ${place}.${key} names the place ${slot.place}, which the table holds`);
    }
  }
}

/** The section of docs/recordings.md that starts at `heading`, up to the next `## ` heading. */
function docsSection(heading: string): string {
  const docs = fs.readFileSync(path.join(REPO_ROOT, "docs", "recordings.md"), "utf8");
  const start = docs.indexOf(heading);
  assert.notEqual(start, -1, `docs/recordings.md has a section "${heading.replace(/^#+ /, "")}"`);
  const end = docs.indexOf("\n## ", start);
  return docs.slice(start, end === -1 ? undefined : end);
}

function namedKeys(section: string): string[] {
  return [...section.matchAll(/`([A-Za-z_$]+)`/g)].map((match) => match[1]!);
}

test("the committed Claude protocol words equal what the pinned sdk.d.ts allows, place by place", () => {
  assert.ok(fs.existsSync(CLAUDE_SDK_DECLARATIONS), CLAUDE_SDK_DECLARATIONS);
  const pinned = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), "utf8")) as { version: string };
  assert.equal(pinned.version, "0.3.330", "the words were derived from the pinned SDK 0.3.330");
  const derived = deriveClaudeProtocolWords();
  assert.deepEqual(Object.keys(CLAUDE_PROTOCOL_WORDS), Object.keys(derived), "the places (run `node test/recordings/claude/derive-protocol-words.ts` to see the derivation)");
  assert.deepEqual(plain(CLAUDE_PROTOCOL_WORDS), plain(derived));
  assertWhole(CLAUDE_PROTOCOL_WORDS, "Claude");
});

test("the Claude protocol words hold the discriminants an account named like them would otherwise break, where the SDK puts them, and nothing in an opaque value", () => {
  for (const word of ["user", "assistant", "system"]) {
    assert.ok(isProtocolWordAt(CLAUDE_PROTOCOL_WORDS, ["message", "type"], word), `an SDK message's type: ${word}`);
    assert.ok(isProtocolWordAt(CLAUDE_PROTOCOL_WORDS, ["message", "message", "role"], word), `its message's role: ${word}`);
  }
  assert.ok(isProtocolWordAt(CLAUDE_PROTOCOL_WORDS, ["message", "message", "content", "type"], "text"), "a content block's type: text");
  assert.ok(isProtocolWordAt(CLAUDE_PROTOCOL_WORDS, ["message", "apiKeySource"], "user"));
  assert.ok(isProtocolWordAt(CLAUDE_PROTOCOL_WORDS, ["message", "subtype"], "init"));
  assert.ok(isProtocolWordAt(CLAUDE_PROTOCOL_WORDS, ["message", "permissionMode"], "default"));
  assert.ok(isProtocolWordAt(CLAUDE_PROTOCOL_WORDS, ["message", "error"], "unknown"), "an assistant message's error: unknown");
  assert.ok(isProtocolWordAt(CLAUDE_PROTOCOL_WORDS, ["message", "patch", "status"], "running"), "a task patch's status: running");
  assert.ok(isProtocolWordAt(CLAUDE_PROTOCOL_WORDS, ["message", "event", "content_block", "tool_changes", "tool", "definition", "name"], "memory"), "a tool definition's name: memory");
  assert.ok(isProtocolWordAt(CLAUDE_PROTOCOL_WORDS, ["value", "type"], "user"), "a session message read back: type user");
  // The SDK types a user message's tool_use_result as unknown, a can_use_tool frame's toolName as a string and its input as Record<string, unknown>: no words there.
  for (const [where, word] of [
    [["message", "tool_use_result", "name"], "memory"],
    [["message", "tool_use_result", "status"], "running"],
    [["message", "tool_use_result", "error"], "unknown"],
    [["message", "tool_use_result", "type"], "user"],
    [["toolName"], "Bash"],
    [["input", "name"], "memory"],
  ] as const) {
    assert.ok(!isProtocolWordAt(CLAUDE_PROTOCOL_WORDS, where, word), `${where.join(".")}: ${word} is no protocol word there`);
  }
  // Free-text keys are not protocol keys, so a user name there is replaced.
  const keys = protocolKeys(CLAUDE_PROTOCOL_WORDS);
  for (const key of ["text", "stdout", "stderr", "content", "data", "command"]) assert.equal(keys[key], undefined, key);
});

test("docs/recordings.md names every Claude protocol key and says where the words come from", () => {
  const section = docsSection("### Claude protocol words");
  assert.match(section, /sdk\.d\.ts/);
  const named = namedKeys(section);
  for (const key of Object.keys(protocolKeys(CLAUDE_PROTOCOL_WORDS))) assert.ok(named.includes(key), `the docs name ${key}`);
});

test("the committed OpenCode protocol words equal what the pinned @opencode/client declarations allow, place by place", () => {
  assert.ok(fs.existsSync(OPENCODE_CLIENT_DECLARATIONS), OPENCODE_CLIENT_DECLARATIONS);
  const pinned = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "node_modules", "@opencode", "client", "package.json"), "utf8")) as { version: string };
  assert.equal(pinned.version, "2.1.2", "the words were derived from the pinned @opencode/client 2.1.2");
  const derived = deriveOpencodeProtocolWords();
  assert.deepEqual(Object.keys(OPENCODE_PROTOCOL_WORDS), Object.keys(derived), "the places (run `node test/recordings/opencode/derive-protocol-words.ts` to see the derivation)");
  assert.deepEqual(plain(OPENCODE_PROTOCOL_WORDS), plain(derived));
  assertWhole(OPENCODE_PROTOCOL_WORDS, "OpenCode");
});

test("the OpenCode protocol words hold the discriminants an account named like them would otherwise break, where the client's types put them", () => {
  for (const word of ["server.connected", "session.text.delta", "session.execution.succeeded", "permission.asked"]) assert.ok(isProtocolWordAt(OPENCODE_PROTOCOL_WORDS, ["event", "type"], word), `an event's type: ${word}`);
  for (const word of ["user", "assistant"]) assert.ok(isProtocolWordAt(OPENCODE_PROTOCOL_WORDS, ["body", "data", "type"], word), `a message's type: ${word}`);
  for (const word of ["text", "tool", "reasoning"]) assert.ok(isProtocolWordAt(OPENCODE_PROTOCOL_WORDS, ["body", "data", "content", "type"], word), `a part's type: ${word}`);
  assert.ok(isProtocolWordAt(OPENCODE_PROTOCOL_WORDS, ["body", "_tag"], "SessionNotFoundError"));
  assert.deepEqual([...protocolKeys(OPENCODE_PROTOCOL_WORDS)["effect"]!], ["allow", "ask", "deny"]);
  assert.ok(!isProtocolWordAt(OPENCODE_PROTOCOL_WORDS, ["event", "data", "content", "text"], "text"), "free text is no protocol word");
  // Free-text keys are not protocol keys, so a user name there is replaced.
  const keys = protocolKeys(OPENCODE_PROTOCOL_WORDS);
  for (const key of ["text", "delta", "content", "message", "title", "directory"]) assert.equal(keys[key], undefined, key);
});

test("docs/recordings.md names every OpenCode protocol key and says where the words come from", () => {
  const section = docsSection("### OpenCode protocol words");
  assert.match(section, /@opencode\/client\/dist\/promise\/index\.d\.ts/);
  const named = namedKeys(section);
  for (const key of Object.keys(protocolKeys(OPENCODE_PROTOCOL_WORDS))) assert.ok(named.includes(key), `the docs name ${key}`);
});

test("the committed ACP protocol words equal what the vendored ACP schemas allow, place by place", () => {
  assert.equal(path.relative(REPO_ROOT, ACP_SCHEMA_DIRECTORY).split(path.sep).join("/"), "vendor-schemas/acp/schema-v2.0.0-beta.3", "the release the ACP drivers are built on");
  for (const version of ["v1", "v2"]) assert.ok(fs.existsSync(path.join(ACP_SCHEMA_DIRECTORY, version, "schema.unstable.json")), version);
  const derived = deriveAcpProtocolWords();
  assert.deepEqual(Object.keys(ACP_PROTOCOL_WORDS), Object.keys(derived), "the places (run `node test/recordings/acp/derive-protocol-words.ts` to see the derivation)");
  assert.deepEqual(plain(ACP_PROTOCOL_WORDS), plain(derived));
  assertWhole(ACP_PROTOCOL_WORDS, "ACP");
});

test("the ACP protocol word derivation fails on a schema that drifts: a new enum value or a new method appears in the derivation, where the schema puts it", () => {
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
    assert.ok(isProtocolWordAt(drifted, ["message", "result", "stopReason"], "drifted_stop_reason"), "a prompt response's stopReason");
    assert.ok(!isProtocolWordAt(ACP_PROTOCOL_WORDS, ["message", "result", "stopReason"], "drifted_stop_reason"));
    assert.ok(isProtocolWordAt(drifted, ["message", "method"], "drifted/method"));
    assert.notDeepEqual(plain(drifted), plain(ACP_PROTOCOL_WORDS), "the committed words no longer equal the derivation");
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test("the ACP protocol words hold the discriminants an account named like them would otherwise break, where the schemas put them, and nothing in an agent's _meta", () => {
  for (const word of ["agent_message_chunk", "tool_call_update", "config_option_update", "usage_update"]) assert.ok(isProtocolWordAt(ACP_PROTOCOL_WORDS, ["message", "params", "update", "sessionUpdate"], word), `sessionUpdate: ${word}`);
  assert.ok(isProtocolWordAt(ACP_PROTOCOL_WORDS, ["message", "params", "update", "content", "type"], "text"), "a chunk's content type: text");
  for (const word of ["allow_once", "reject_once"]) assert.ok(isProtocolWordAt(ACP_PROTOCOL_WORDS, ["message", "params", "options", "kind"], word), `a permission option's kind: ${word}`);
  assert.ok(isProtocolWordAt(ACP_PROTOCOL_WORDS, ["message", "params", "toolCall", "kind"], "execute"), "a tool call's kind: execute");
  for (const word of ["session/update", "session/request_permission"]) assert.ok(isProtocolWordAt(ACP_PROTOCOL_WORDS, ["message", "method"], word), `method: ${word}`);
  assert.ok(isProtocolWordAt(ACP_PROTOCOL_WORDS, ["message", "result", "configOptions", "category"], "model"));
  assert.ok(isProtocolWordAt(ACP_PROTOCOL_WORDS, ["message", "jsonrpc"], "2.0"));
  assert.ok(!isProtocolWordAt(ACP_PROTOCOL_WORDS, ["message", "params", "update", "_meta", "ari.test/x", "type"], "text"), "an agent's _meta is opaque");
  // Free-text keys are not protocol keys, so a user name there is replaced.
  const keys = protocolKeys(ACP_PROTOCOL_WORDS);
  for (const key of ["text", "title", "name", "message", "sessionId", "cwd", "description"]) assert.equal(keys[key], undefined, key);
});

test("docs/recordings.md names every ACP protocol key and says where the words come from", () => {
  const section = docsSection("### ACP protocol words");
  assert.match(section, /vendor-schemas\/acp\/schema-v2\.0\.0-beta\.3/);
  const named = namedKeys(section);
  for (const key of Object.keys(protocolKeys(ACP_PROTOCOL_WORDS))) assert.ok(named.includes(key), `the docs name ${key}`);
});

test("the committed Codex protocol words equal what the vendored app-server schema allows, place by place", () => {
  assert.equal(path.relative(REPO_ROOT, CODEX_SCHEMA_DIRECTORY).split(path.sep).join("/"), "vendor-schemas/codex/3d86e43b075adeba2193ec5c22ac92f55afd82e6", "the schema of Codex tag rust-v0.172.0, which the driver's client is generated from");
  assert.ok(fs.existsSync(path.join(CODEX_SCHEMA_DIRECTORY, "codex_app_server_protocol.schemas.json")));
  const derived = deriveCodexProtocolWords();
  assert.deepEqual(Object.keys(CODEX_PROTOCOL_WORDS), Object.keys(derived), "the places (run `node test/recordings/codex/derive-protocol-words.ts` to see the derivation)");
  assert.deepEqual(plain(CODEX_PROTOCOL_WORDS), plain(derived));
  assertWhole(CODEX_PROTOCOL_WORDS, "Codex");
});

test("the Codex protocol word derivation fails on a schema that drifts: a new item type or a new notification appears in the derivation, where the schema puts it", () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "ari-codex-schema-"));
  try {
    for (const file of ["codex_app_server_protocol.schemas.json", "hand-written-additions.json"]) fs.copyFileSync(path.join(CODEX_SCHEMA_DIRECTORY, file), path.join(copy, file));
    const schema = JSON.parse(fs.readFileSync(path.join(copy, "codex_app_server_protocol.schemas.json"), "utf8")) as { definitions: { v2: { [name: string]: { enum?: string[] } }; ServerNotification: { oneOf: unknown[] } } };
    schema.definitions.v2["TurnStatus"]!.enum!.push("drifted_status");
    schema.definitions.ServerNotification.oneOf.push({ properties: { method: { enum: ["drifted/notification"], type: "string" }, params: { $ref: "#/definitions/v2/TurnCompletedNotification" } }, required: ["method", "params"], type: "object" });
    fs.writeFileSync(path.join(copy, "codex_app_server_protocol.schemas.json"), JSON.stringify(schema));
    const drifted = deriveCodexProtocolWords(copy);
    assert.ok(isProtocolWordAt(drifted, ["message", "params", "turn", "status"], "drifted_status"), "a turn's status");
    assert.ok(!isProtocolWordAt(CODEX_PROTOCOL_WORDS, ["message", "params", "turn", "status"], "drifted_status"));
    assert.ok(isProtocolWordAt(drifted, ["message", "method"], "drifted/notification"));
    assert.notDeepEqual(plain(drifted), plain(CODEX_PROTOCOL_WORDS), "the committed words no longer equal the derivation");
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test("the Codex protocol words hold the discriminants an account named like them would otherwise break, where the schema puts them, and nothing in free text", () => {
  for (const word of ["turn/started", "turn/completed", "item/started", "item/completed", "item/agentMessage/delta", "item/commandExecution/requestApproval", "account/rateLimits/updated"]) assert.ok(isProtocolWordAt(CODEX_PROTOCOL_WORDS, ["message", "method"], word), `method: ${word}`);
  for (const word of ["agentMessage", "userMessage", "commandExecution", "reasoning"]) assert.ok(isProtocolWordAt(CODEX_PROTOCOL_WORDS, ["message", "params", "item", "type"], word), `an item's type: ${word}`);
  for (const word of ["completed", "interrupted", "failed", "inProgress"]) assert.ok(isProtocolWordAt(CODEX_PROTOCOL_WORDS, ["message", "params", "turn", "status"], word), `a turn's status: ${word}`);
  assert.ok(isProtocolWordAt(CODEX_PROTOCOL_WORDS, ["message", "params", "item", "content", "type"], "text"), "a user message's content type: text");
  for (const word of ["accept", "cancel"]) assert.ok(isProtocolWordAt(CODEX_PROTOCOL_WORDS, ["message", "params", "availableDecisions"], word), `an approval's decision: ${word}`);
  assert.ok(isProtocolWordAt(CODEX_PROTOCOL_WORDS, ["message", "params", "rateLimits", "planType"], "plus"), "a rate-limit report's plan type");
  for (const where of [["message", "params", "item", "text"], ["message", "params", "item", "aggregatedOutput"], ["message", "params", "delta"], ["message", "result", "userAgent"]] as const) assert.ok(!isProtocolWordAt(CODEX_PROTOCOL_WORDS, where, "completed"), `${where.join(".")} is free text`);
  // Free-text keys are not protocol keys, so a user name there is replaced.
  const keys = protocolKeys(CODEX_PROTOCOL_WORDS);
  for (const key of ["text", "delta", "aggregatedOutput", "command", "cwd", "message", "userAgent"]) assert.equal(keys[key], undefined, key);
});

test("docs/recordings.md names every Codex protocol key and says where the words come from", () => {
  const section = docsSection("### Codex protocol words");
  assert.match(section, /vendor-schemas\/codex\/3d86e43b075adeba2193ec5c22ac92f55afd82e6/);
  const named = namedKeys(section);
  for (const key of Object.keys(protocolKeys(CODEX_PROTOCOL_WORDS))) assert.ok(named.includes(key), `the docs name ${key}`);
});
