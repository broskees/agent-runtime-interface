// Derives the Codex protocol words from the vendored app-server schema
// (vendor-schemas/codex/<commit>/codex_app_server_protocol.schemas.json, Codex
// tag rust-v0.172.0, the schema the driver's client is generated from), by
// place (../protocol-places.ts): for every spot of an inbound stdio frame the
// schema describes, the string values it allows as each key's value there
// (each `const` and `enum`). A notification's `method` gets `turn/started`,
// `item/agentMessage/delta`, ...; an item's `type` gets `agentMessage`,
// `commandExecution`, ...; a turn's `status` gets `completed`, `interrupted`,
// ...; and so on. ./protocol-words.ts holds the result, and
// test/recordings/protocol-words.test.ts checks it still equals this
// derivation.
//
// The root is the `message` of an inbound stdio frame (../stdio/frames.ts):
// what `codex app-server` writes to stdout. That is a server request (every
// variant of the schema's `ServerRequest`), a notification (every variant of
// `ServerNotification`), an error answer (`JSONRPCError`), or the answer to
// one of the requests the driver sends (CLIENT_REQUESTS of
// scripts/codegen-codex.ts): `{ id, result }` with that request's response
// type, which is `<X>Response` for params `<X>Params` except where the
// schema's hand-written-additions.json names another, as the codegen reads
// it. The walk follows every `$ref`, `allOf`, `anyOf` and `oneOf`, every
// property, array item and additional property from there.
//
// Usage: node test/recordings/codex/derive-protocol-words.ts   (prints the words as JSON)

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ADDITIONS_FILE, CLIENT_REQUESTS, CODEX_SOURCE, SCHEMA_FILE } from "../../../scripts/codegen-codex.ts";
import { adoptSchema, isSchema, jsonSchemaGraph, schemaDocument } from "../json-schema-places.ts";
import type { Schema } from "../json-schema-places.ts";
import { placeProtocolWords } from "../protocol-places.ts";
import type { ProtocolWords } from "../protocol-places.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The vendored Codex schema directory of the pinned tag. */
export const CODEX_SCHEMA_DIRECTORY = path.join(REPO_ROOT, "vendor-schemas", "codex", CODEX_SOURCE.commit);

function definition(document: Schema, name: string, file: string): Schema {
  const definitions = document["definitions"];
  const found = isSchema(definitions) ? definitions[name] : undefined;
  if (!isSchema(found)) throw new Error(`${file} has no definition ${name}`);
  return found;
}

/** The `$ref` of a request's params, also through `anyOf: [ref, null]`. */
function paramsRef(params: unknown): string | undefined {
  if (!isSchema(params)) return undefined;
  if (typeof params["$ref"] === "string") return params["$ref"];
  const refs = (Array.isArray(params["anyOf"]) ? params["anyOf"] : []).filter((option): option is Schema => isSchema(option) && typeof option["$ref"] === "string");
  return refs.length === 1 ? (refs[0]!["$ref"] as string) : undefined;
}

/** The words the vendored schema allows, by place. */
export function deriveCodexProtocolWords(directory = CODEX_SCHEMA_DIRECTORY): ProtocolWords {
  const file = path.join(directory, SCHEMA_FILE);
  const document = schemaDocument(file);
  const additionsPath = path.join(directory, ADDITIONS_FILE);
  const additions = (fs.existsSync(additionsPath) ? JSON.parse(fs.readFileSync(additionsPath, "utf8")) : { responseTypes: {} }) as { responseTypes: { [method: string]: string } };
  const v2 = definition(document, "v2", file);

  // The response type of each request the driver sends.
  const requests = definition(document, "ClientRequest", file);
  const variants = (Array.isArray(requests["oneOf"]) ? requests["oneOf"] : []).filter(isSchema);
  const results: Schema[] = CLIENT_REQUESTS.map((method) => {
    const override = additions.responseTypes[method];
    if (override !== undefined) return { $ref: isSchema(v2[override]) ? `#/definitions/v2/${override}` : `#/definitions/${override}` };
    const variant = variants.find((each) => {
      const named = isSchema(each["properties"]) ? each["properties"]["method"] : undefined;
      return isSchema(named) && Array.isArray(named["enum"]) && named["enum"].includes(method);
    });
    if (variant === undefined) throw new Error(`${file}: ClientRequest has no method ${method}`);
    const ref = paramsRef((variant["properties"] as Schema)["params"]);
    if (ref === undefined || !ref.endsWith("Params")) throw new Error(`${file}: cannot name the response type of ${method}`);
    return { $ref: `${ref.slice(0, -"Params".length)}Response` };
  });
  const answer: Schema = { properties: { id: { $ref: "#/definitions/RequestId" }, result: { anyOf: results } } };
  adoptSchema(answer, document, file);

  const messages = [definition(document, "ServerRequest", file), definition(document, "ServerNotification", file), definition(document, "JSONRPCError", file), answer];
  return placeProtocolWords({ message: messages }, jsonSchemaGraph());
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(deriveCodexProtocolWords(), null, 2)}\n`);
}
