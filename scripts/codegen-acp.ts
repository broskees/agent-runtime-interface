// Generates the ACP protocol types the `acp` driver's clients are built on,
// from the ACP JSON Schemas vendored in vendor-schemas/acp/<release>/:
//   - src/drivers/acp/generated/v1.ts from v1/schema.unstable.json
//   - src/drivers/acp/generated/v2.ts from v2/schema.unstable.json
//
// Each module holds one TypeScript type per schema definition, and method
// tables built from the definitions' `x-method` and `x-side` markers: which
// requests and notifications the agent handles, which the client handles,
// with their params and result types. The driver's connection is typed by
// these tables, so a method or field the vendor schema does not define does
// not compile.
//
// The unstable schema is the stable schema plus draft features (the driver
// needs one of them, `session/fork`), so the types come from it; each module
// also lists which methods the stable schema has.
//
// Usage:
//   node scripts/codegen-acp.ts            write the generated modules
//   node scripts/codegen-acp.ts --check    exit 1 if a generated module is stale
//   --root <dir>                           run against another checkout (tests use it)
//
// Every keyword the schemas use must be one this script knows: it turns the
// structural ones into types and ignores the validation-only ones listed in
// IGNORED_KEYWORDS. An unknown keyword fails codegen, so a vendor schema
// update that adds one is noticed.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** The vendored ACP schema release, the tag of github.com/agentclientprotocol/agent-client-protocol it came from. */
export const ACP_SCHEMA_RELEASE = "schema-v2.0.0-beta.3";

export const ACP_VERSIONS = [1, 2] as const;

const STRUCTURAL_KEYWORDS = new Set([
  "$ref",
  "type",
  "const",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "allOf",
  "anyOf",
  "oneOf",
  "description",
  "title",
]);

// Keywords that only narrow values (or only annotate them) and need no type of their own.
const IGNORED_KEYWORDS = new Set([
  "$schema",
  "$defs",
  "$anchor",
  "default",
  "format",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "pattern",
  "not",
  "discriminator",
  "if",
  "then",
  "else",
  "unevaluatedProperties",
  "propertyNames",
  "contentEncoding",
  "x-side",
  "x-method",
  "x-methods",
  "x-state",
  "x-scope",
  "x-docs-ignore",
  "x-deserialize-default-on-error",
  "x-deserialize-default-on-null",
  "x-deserialize-skip-invalid-items",
]);

export class AcpCodegenError extends Error {}

type Schema = { readonly [key: string]: unknown } | boolean;

interface SchemaDocument {
  readonly $defs: { readonly [name: string]: Schema };
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function vendorDirectory(root: string): string {
  return path.join(root, "vendor-schemas", "acp", ACP_SCHEMA_RELEASE);
}

/** The first paragraph of a description, safe inside a block comment. */
function firstParagraph(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const paragraph = text.split(/\n\s*\n/)[0]?.trim();
  if (paragraph === undefined || paragraph === "" || paragraph === "**UNSTABLE**") {
    const rest = text.split(/\n\s*\n/).slice(1).find((part) => part.trim() !== "");
    return rest === undefined ? undefined : rest.trim().replaceAll("*/", "*\\/").replace(/\s*\n\s*/g, " ");
  }
  return paragraph.replaceAll("*/", "*\\/").replace(/\s*\n\s*/g, " ");
}

function jsDoc(text: string | undefined, indent: string): string {
  return text === undefined ? "" : `${indent}/** ${text} */\n`;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function propertyKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function refName(ref: unknown, where: string): string {
  const match = typeof ref === "string" ? /^#\/\$defs\/([A-Za-z_][A-Za-z0-9_]*)$/.exec(ref) : null;
  if (match === null) throw new AcpCodegenError(`${where}: unsupported $ref ${JSON.stringify(ref)}`);
  return match[1]!;
}

/** True when `type` has a `|` or `&` outside brackets and string literals, so it needs parentheses inside a union or intersection. */
function hasTopLevelOperator(type: string): boolean {
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < type.length; index += 1) {
    const character = type[index]!;
    if (quoted) {
      if (character === "\\") index += 1;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{" || character === "(" || character === "[" || character === "<") depth += 1;
    else if (character === "}" || character === ")" || character === "]" || character === ">") depth -= 1;
    else if (depth === 0 && (character === "|" || character === "&")) return true;
  }
  return false;
}

function wrap(type: string): string {
  return hasTopLevelOperator(type) ? `(${type})` : type;
}

function checkKeywords(schema: { readonly [key: string]: unknown }, where: string): void {
  for (const keyword of Object.keys(schema)) {
    if (!STRUCTURAL_KEYWORDS.has(keyword) && !IGNORED_KEYWORDS.has(keyword)) {
      throw new AcpCodegenError(`${where}: unsupported keyword "${keyword}"`);
    }
  }
}

function objectType(schema: { readonly [key: string]: unknown }, where: string, indent: string): string {
  const properties = (schema["properties"] ?? {}) as { readonly [name: string]: Schema };
  const required = new Set((schema["required"] ?? []) as string[]);
  const additional = schema["additionalProperties"] as Schema | undefined;
  const names = Object.keys(properties);
  const lines: string[] = [];
  for (const name of names) {
    const property = properties[name]!;
    const doc = typeof property === "object" ? firstParagraph(property["description"]) : undefined;
    lines.push(`${jsDoc(doc, `${indent}  `)}${indent}  ${propertyKey(name)}${required.has(name) ? "" : "?"}: ${typeOf(property, `${where}.${name}`, `${indent}  `)};\n`);
  }
  if (names.length === 0) {
    if (additional === false) return "{ [key: string]: never }";
    const value = additional === undefined || additional === true ? "unknown" : typeOf(additional, `${where}[*]`, indent);
    return `{ [key: string]: ${value} }`;
  }
  if (additional !== undefined && additional !== false) lines.push(`${indent}  [key: string]: unknown;\n`);
  return `{\n${lines.join("")}${indent}}`;
}

function typeKeyword(schema: { readonly [key: string]: unknown }, where: string, indent: string): string {
  const types = Array.isArray(schema["type"]) ? (schema["type"] as string[]) : [schema["type"] as string];
  return types
    .map((type) => {
      switch (type) {
        case "string":
          return "string";
        case "integer":
        case "number":
          return "number";
        case "boolean":
          return "boolean";
        case "null":
          return "null";
        case "array": {
          const items = schema["items"] as Schema | undefined;
          return items === undefined ? "unknown[]" : `Array<${typeOf(items, `${where}[]`, indent)}>`;
        }
        case "object":
          return objectType(schema, where, indent);
        default:
          throw new AcpCodegenError(`${where}: unsupported type ${JSON.stringify(type)}`);
      }
    })
    .join(" | ");
}

/** The TypeScript type of one schema. */
export function typeOf(schema: Schema, where: string, indent = ""): string {
  if (schema === true) return "unknown";
  if (schema === false) return "never";
  checkKeywords(schema, where);
  const parts: string[] = [];
  if (schema["$ref"] !== undefined) parts.push(refName(schema["$ref"], where));
  if ("const" in schema) parts.push(JSON.stringify(schema["const"]));
  else if (Array.isArray(schema["enum"])) parts.push((schema["enum"] as unknown[]).map((value) => JSON.stringify(value)).join(" | "));
  else if (schema["type"] !== undefined) parts.push(typeKeyword(schema, where, indent));
  else if (schema["properties"] !== undefined) parts.push(objectType(schema, where, indent));
  for (const member of (schema["allOf"] ?? []) as Schema[]) parts.push(typeOf(member, `${where}.allOf`, indent));
  for (const keyword of ["anyOf", "oneOf"]) {
    const members = schema[keyword] as Schema[] | undefined;
    if (members === undefined) continue;
    parts.push(members.map((member, index) => wrap(typeOf(member, `${where}.${keyword}[${index}]`, indent))).join(" | "));
  }
  if (parts.length === 0) return "unknown";
  if (parts.length === 1) return parts[0]!;
  return parts.map(wrap).join(" & ");
}

interface MethodEntry {
  readonly method: string;
  readonly params?: string;
  readonly result?: string;
  readonly notification?: string;
}

/** The method tables of one schema, by the side that handles the method. */
function methodTables(document: SchemaDocument, file: string): Map<string, Map<string, MethodEntry>> {
  const sides = new Map<string, Map<string, MethodEntry>>();
  for (const [name, schema] of Object.entries(document.$defs)) {
    if (typeof schema !== "object") continue;
    const method = schema["x-method"];
    const side = schema["x-side"];
    if (method === undefined && side === undefined) continue;
    if (typeof method !== "string" || typeof side !== "string") throw new AcpCodegenError(`${file}: ${name} has x-method without x-side or the other way round`);
    const table = sides.get(side) ?? new Map<string, MethodEntry>();
    sides.set(side, table);
    const entry: MethodEntry = table.get(method) ?? { method };
    if (name.endsWith("Notification")) table.set(method, { ...entry, notification: name });
    else if (name.endsWith("Request")) table.set(method, { ...entry, params: name });
    else if (name.endsWith("Response")) table.set(method, { ...entry, result: name });
    else throw new AcpCodegenError(`${file}: cannot tell whether ${name} (x-method ${method}) is a request, a response or a notification`);
  }
  return sides;
}

function stableMethods(document: SchemaDocument): string[] {
  const methods = new Set<string>();
  for (const schema of Object.values(document.$defs)) {
    if (typeof schema === "object" && typeof schema["x-method"] === "string") methods.add(schema["x-method"]);
  }
  return [...methods].sort();
}

const SIDE_DOCS: { readonly [side: string]: { readonly requests: string; readonly notifications: string; readonly what: string } } = {
  agent: { requests: "AgentMethods", notifications: "AgentNotifications", what: "the agent handles (the client sends them)" },
  client: { requests: "ClientMethods", notifications: "ClientNotifications", what: "the client handles (the agent sends them)" },
  protocol: { requests: "ProtocolMethods", notifications: "ProtocolNotifications", what: "either side may send" },
};

/** The generated module for one protocol version. */
export function generateVersion(root: string, version: number): string {
  const directory = vendorDirectory(root);
  const relSchema = `vendor-schemas/acp/${ACP_SCHEMA_RELEASE}/v${version}/schema.unstable.json`;
  const unstable = readJson(path.join(directory, `v${version}`, "schema.unstable.json")) as SchemaDocument;
  const stable = readJson(path.join(directory, `v${version}`, "schema.json")) as SchemaDocument;
  if (typeof unstable.$defs !== "object" || unstable.$defs === null) throw new AcpCodegenError(`${relSchema} has no $defs`);

  const out: string[] = [];
  out.push(`// Generated by scripts/codegen-acp.ts from ${relSchema}. Do not edit.\n`);
  out.push(`// Change the vendored schema and run \`pnpm run codegen:acp\` instead.\n`);
  out.push(`/* eslint-disable */\n\n`);
  out.push(`/** The vendored ACP schema release these types come from. */\n`);
  out.push(`export const ACP_SCHEMA_RELEASE = ${JSON.stringify(ACP_SCHEMA_RELEASE)};\n\n`);
  out.push(`/** The ACP protocol version this module describes. */\n`);
  out.push(`export const PROTOCOL_VERSION = ${version};\n\n`);

  for (const [name, schema] of Object.entries(unstable.$defs)) {
    const doc = typeof schema === "object" ? firstParagraph(schema["description"]) : undefined;
    out.push(`${jsDoc(doc, "")}export type ${name} = ${typeOf(schema, `${relSchema}#/$defs/${name}`)};\n\n`);
  }

  const tables = methodTables(unstable, relSchema);
  for (const side of ["agent", "client", "protocol"]) {
    const docs = SIDE_DOCS[side]!;
    const table = [...(tables.get(side) ?? new Map<string, MethodEntry>()).values()].sort((a, b) => a.method.localeCompare(b.method));
    const requests = table.filter((entry) => entry.params !== undefined || entry.result !== undefined);
    const notifications = table.filter((entry) => entry.notification !== undefined);
    out.push(`/** Requests ${docs.what}: params and result types by method. */\n`);
    out.push(`export interface ${docs.requests} {\n`);
    for (const entry of requests) {
      if (entry.params === undefined || entry.result === undefined) {
        throw new AcpCodegenError(`${relSchema}: ${entry.method} has ${entry.params === undefined ? "no request" : "no response"} definition`);
      }
      out.push(`  ${JSON.stringify(entry.method)}: { params: ${entry.params}; result: ${entry.result} };\n`);
    }
    out.push(`}\n\n`);
    out.push(`/** Notifications ${docs.what}: params types by method. */\n`);
    out.push(`export interface ${docs.notifications} {\n`);
    for (const entry of notifications) out.push(`  ${JSON.stringify(entry.method)}: ${entry.notification};\n`);
    out.push(`}\n\n`);
  }
  out.push(`/** Every method the stable v${version} schema (schema.json) defines; the rest are draft features. */\n`);
  out.push(`export const STABLE_METHODS: readonly string[] = ${JSON.stringify(stableMethods(stable))};\n`);
  return out.join("");
}

/** Every generated file, by repo-relative path. */
export function generate(root: string): Map<string, string> {
  const outputs = new Map<string, string>();
  for (const version of ACP_VERSIONS) outputs.set(`src/drivers/acp/generated/v${version}.ts`, generateVersion(root, version));
  return outputs;
}

/** Repo-relative paths whose committed content differs from what codegen writes. */
export function findDrift(root: string): string[] {
  const drift: string[] = [];
  const outputs = generate(root);
  for (const [relative, content] of outputs) {
    const full = path.join(root, relative);
    if (!fs.existsSync(full)) drift.push(`${relative} is missing`);
    else if (fs.readFileSync(full, "utf8") !== content) drift.push(`${relative} differs from the vendored ACP schema`);
  }
  const generatedDirectory = path.join(root, "src", "drivers", "acp", "generated");
  if (fs.existsSync(generatedDirectory)) {
    for (const name of fs.readdirSync(generatedDirectory)) {
      const relative = `src/drivers/acp/generated/${name}`;
      if (!outputs.has(relative)) drift.push(`${relative} is not produced by codegen-acp`);
    }
  }
  return drift;
}

function main(argv: string[]): number {
  const check = argv.includes("--check");
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex === -1 ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") : path.resolve(argv[rootIndex + 1] ?? ".");
  try {
    if (check) {
      const drift = findDrift(root);
      if (drift.length > 0) {
        process.stderr.write(`codegen:acp:check failed. Run \`pnpm run codegen:acp\`.\n${drift.map((line) => `  ${line}`).join("\n")}\n`);
        return 1;
      }
      process.stdout.write(`codegen:acp:check passed: src/drivers/acp/generated matches vendor-schemas/acp/${ACP_SCHEMA_RELEASE}.\n`);
      return 0;
    }
    const outputs = generate(root);
    fs.mkdirSync(path.join(root, "src", "drivers", "acp", "generated"), { recursive: true });
    for (const [relative, content] of outputs) fs.writeFileSync(path.join(root, relative), content);
    process.stdout.write(`codegen-acp wrote src/drivers/acp/generated from vendor-schemas/acp/${ACP_SCHEMA_RELEASE}.\n`);
    return 0;
  } catch (error) {
    if (error instanceof AcpCodegenError) {
      process.stderr.write(`codegen-acp failed: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
