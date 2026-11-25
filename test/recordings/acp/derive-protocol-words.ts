// Derives the ACP protocol words from the vendored ACP schemas
// (vendor-schemas/acp/schema-v2.0.0-beta.3/, the release the ACP drivers are
// built on): for every object key an ACP agent can put in a message to the
// client, the string values the schemas allow as that key's value (each
// `const` and `enum`). `type` gets `text`, `resource_link`, ...;
// `sessionUpdate` gets `agent_message_chunk`, `tool_call`, ...; `kind` gets
// `allow_once`, `execute`, ...; and so on. ./protocol-words.ts holds the
// result, and test/recordings/protocol-words.test.ts checks it still equals
// this derivation.
//
// The roots are what an inbound ACP frame carries, in both protocol versions
// (`v1/` and `v2/`), from the unstable schemas the driver's types come from:
// the `Agent` message (every request, response and notification an agent
// sends) and the `ProtocolLevel` message (`$/cancel_request`). The walk
// follows every `$ref`, `allOf`, `anyOf` and `oneOf`, every property, array
// item and additional property from there. A JSON-RPC message's `method`
// holds a method name rather than a schema literal, so `method` gets the
// methods an agent sends: the `clientMethods` and `protocolMethods` of each
// version's `meta.unstable.json`.
//
// Usage: node test/recordings/acp/derive-protocol-words.ts   (prints the words as JSON)

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The vendored ACP schema release. */
export const ACP_SCHEMA_DIRECTORY = path.join(REPO_ROOT, "vendor-schemas", "acp", "schema-v2.0.0-beta.3");

type Schema = { readonly [key: string]: unknown };

const COMBINATIONS = ["allOf", "anyOf", "oneOf"] as const;

function isSchema(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** For each key, the sorted string values the vendored schemas allow; keys sorted. */
export function deriveAcpProtocolWords(directory = ACP_SCHEMA_DIRECTORY): { [key: string]: string[] } {
  const words = new Map<string, Set<string>>();
  const add = (key: string, value: string): void => {
    const own = words.get(key) ?? new Set<string>();
    own.add(value);
    words.set(key, own);
  };

  for (const version of ["v1", "v2"]) {
    const root = JSON.parse(fs.readFileSync(path.join(directory, version, "schema.unstable.json"), "utf8")) as Schema;
    const definitions = (root["$defs"] ?? {}) as { [name: string]: Schema };
    const resolve = (node: Schema): Schema => {
      const reference = node["$ref"];
      if (typeof reference !== "string") return node;
      const name = /^#\/\$defs\/(.+)$/.exec(reference)?.[1];
      const target = name === undefined ? undefined : definitions[name];
      if (target === undefined) throw new Error(`${version}/schema.unstable.json: cannot resolve ${reference}`);
      return target;
    };

    /** The string values a schema allows: its const and enum, through references, combinations and array items. */
    const literals = (node: unknown, seen = new Set<Schema>()): string[] => {
      if (!isSchema(node) || seen.has(node)) return [];
      seen.add(node);
      const found: string[] = [];
      if (typeof node["const"] === "string") found.push(node["const"]);
      if (Array.isArray(node["enum"])) for (const value of node["enum"]) if (typeof value === "string") found.push(value);
      if (typeof node["$ref"] === "string") found.push(...literals(resolve(node), seen));
      for (const combination of COMBINATIONS) if (Array.isArray(node[combination])) for (const member of node[combination] as unknown[]) found.push(...literals(member, seen));
      if (isSchema(node["items"])) found.push(...literals(node["items"], seen));
      return found;
    };

    const visited = new Set<Schema>();
    const visit = (node: unknown): void => {
      if (!isSchema(node) || visited.has(node)) return;
      visited.add(node);
      if (typeof node["$ref"] === "string") visit(resolve(node));
      for (const combination of COMBINATIONS) if (Array.isArray(node[combination])) for (const member of node[combination] as unknown[]) visit(member);
      if (isSchema(node["properties"])) {
        for (const [key, property] of Object.entries(node["properties"])) {
          for (const value of literals(property)) add(key, value);
          visit(property);
        }
      }
      if (isSchema(node["items"])) visit(node["items"]);
      if (Array.isArray(node["prefixItems"])) for (const item of node["prefixItems"] as unknown[]) visit(item);
      if (isSchema(node["additionalProperties"])) visit(node["additionalProperties"]);
    };

    const messages = (Array.isArray(root["anyOf"]) ? root["anyOf"] : []).filter((member): member is Schema => isSchema(member) && (member["title"] === "Agent" || member["title"] === "ProtocolLevel"));
    if (messages.length !== 2) throw new Error(`${version}/schema.unstable.json has no Agent and ProtocolLevel messages`);
    for (const message of messages) visit(message);

    const meta = JSON.parse(fs.readFileSync(path.join(directory, version, "meta.unstable.json"), "utf8")) as { clientMethods?: { [name: string]: string }; protocolMethods?: { [name: string]: string } };
    for (const method of [...Object.values(meta.clientMethods ?? {}), ...Object.values(meta.protocolMethods ?? {})]) add("method", method);
  }

  const result: { [key: string]: string[] } = {};
  for (const key of [...words.keys()].sort()) result[key] = [...words.get(key)!].sort();
  return result;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(deriveAcpProtocolWords(), null, 2)}\n`);
}
