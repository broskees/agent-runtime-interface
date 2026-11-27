// Derives the ACP protocol words from the vendored ACP schemas
// (vendor-schemas/acp/schema-v2.0.0-beta.3/, the release the ACP drivers are
// built on), by place (../protocol-places.ts): for every spot of an inbound
// stdio frame the schemas describe, the string values they allow as each
// key's value there (each `const` and `enum`). A content block's `type` gets
// `text`, `resource_link`, ...; a session update's `sessionUpdate` gets
// `agent_message_chunk`, `tool_call`, ...; a permission option's `kind` gets
// `allow_once`, `reject_once`, ...; and so on. ./protocol-words.ts holds the
// result, and test/recordings/protocol-words.test.ts checks it still equals
// this derivation.
//
// The root is the `message` of an inbound stdio frame (../stdio/frames.ts):
// what an ACP agent writes to stdout, in both protocol versions (`v1/` and
// `v2/`), from the unstable schemas the driver's types come from: the `Agent`
// message (every request, response and notification an agent sends) and the
// `ProtocolLevel` message (`$/cancel_request`). The walk follows every
// `$ref`, `allOf`, `anyOf` and `oneOf`, every property, array item and
// additional property from there. A JSON-RPC message's `method` holds a
// method name rather than a schema literal, so the message's `method` gets
// the methods an agent sends: the `clientMethods` and `protocolMethods` of
// each version's `meta.unstable.json`.
//
// Usage: node test/recordings/acp/derive-protocol-words.ts   (prints the words as JSON)

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isSchema, jsonSchemaGraph, schemaDocument } from "../json-schema-places.ts";
import type { Schema } from "../json-schema-places.ts";
import { placeProtocolWords } from "../protocol-places.ts";
import type { ProtocolWords } from "../protocol-places.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The vendored ACP schema release. */
export const ACP_SCHEMA_DIRECTORY = path.join(REPO_ROOT, "vendor-schemas", "acp", "schema-v2.0.0-beta.3");

/** The words the vendored schemas allow, by place. */
export function deriveAcpProtocolWords(directory = ACP_SCHEMA_DIRECTORY): ProtocolWords {
  const messages: Schema[] = [];
  const methods: string[] = [];
  for (const version of ["v1", "v2"]) {
    const root = schemaDocument(path.join(directory, version, "schema.unstable.json"));
    const found = (Array.isArray(root["anyOf"]) ? root["anyOf"] : []).filter((member): member is Schema => isSchema(member) && (member["title"] === "Agent" || member["title"] === "ProtocolLevel"));
    if (found.length !== 2) throw new Error(`${version}/schema.unstable.json has no Agent and ProtocolLevel messages`);
    messages.push(...found);
    const meta = JSON.parse(fs.readFileSync(path.join(directory, version, "meta.unstable.json"), "utf8")) as { clientMethods?: { [name: string]: string }; protocolMethods?: { [name: string]: string } };
    methods.push(...Object.values(meta.clientMethods ?? {}), ...Object.values(meta.protocolMethods ?? {}));
  }
  return placeProtocolWords({ message: messages }, jsonSchemaGraph(), [{ path: ["message", "method"], words: methods }]);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(deriveAcpProtocolWords(), null, 2)}\n`);
}
