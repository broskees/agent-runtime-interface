// Generates the Codex app-server protocol client from the vendored JSON Schema:
//
//   vendor-schemas/codex/<commit>/codex_app_server_protocol.schemas.json (input)
//   src/drivers/codex/generated/protocol.ts                               (output)
//
// The output holds TypeScript types for every definition reachable from the
// methods the Codex driver and its test fake use (listed below), a typed map
// from each method name to its params and result, and `CodexAppServerClient`,
// which has one method per client request. The bundle names each request's
// params but not its response type: a response is `<X>Response` for params
// `<X>Params`, except where `hand-written-additions.json` beside the schema
// says otherwise (copied from the upstream Rust source, and marked there).
//
// Usage:
//   node scripts/codegen-codex.ts           write the generated file
//   node scripts/codegen-codex.ts --check   exit 1 when the committed file is stale
//   --schema-dir <dir>   read another vendored directory (tests use it)
//   --out <file>         compare or write another output file (tests use it)
//
// The JSON Schema subset the bundle uses is small: `$ref`, `allOf`, `anyOf`,
// `oneOf`, `enum`, `const`, `type` (also as an array), `properties`,
// `required`, `additionalProperties`, `items`, plus annotations and
// constraints (`format`, `minimum`, `minLength`, `default`) that do not change
// the TypeScript type. Any other keyword fails the generator, so a schema
// update that needs more is noticed.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = { [keyword: string]: Json } | boolean;

/** The pinned upstream source. SOURCES.md beside the schema records the same values. */
export const CODEX_SOURCE = {
  repository: "https://github.com/openai/codex",
  tag: "rust-v0.172.0",
  commit: "3d86e43b075adeba2193ec5c22ac92f55afd82e6",
} as const;

export const SCHEMA_FILE = "codex_app_server_protocol.schemas.json";
export const ADDITIONS_FILE = "hand-written-additions.json";
export const OUTPUT_FILE = "src/drivers/codex/generated/protocol.ts";

/** Requests the client sends. */
export const CLIENT_REQUESTS = [
  "initialize",
  "thread/start",
  "thread/resume",
  "thread/fork",
  "thread/read",
  "thread/turns/list",
  "thread/list",
  "thread/archive",
  "thread/delete",
  "thread/unsubscribe",
  "thread/revert",
  "thread/compact/start",
  "thread/inject_items",
  "thread/goal/set",
  "thread/goal/get",
  "thread/goal/clear",
  "thread/backgroundTerminals/list",
  "thread/backgroundTerminals/terminate",
  "thread/memory/read",
  "thread/readState/update",
  "review/start",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "model/list",
  "mcpServerStatus/list",
  "mcpServer/tool/call",
  "mcpServer/resource/read",
  "feedback/upload",
  "account/read",
  "account/login/start",
  "account/login/cancel",
  "account/logout",
  "account/rateLimits/read",
  "account/rateLimitResetCredit/consume",
] as const;

/** Notifications the client sends. */
export const CLIENT_NOTIFICATIONS = ["initialized"] as const;

/** Requests the server sends. */
export const SERVER_REQUESTS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/tool/call",
  "account/chatgptAuthTokens/refresh",
] as const;

/** Notifications the server sends. */
export const SERVER_NOTIFICATIONS = [
  "error",
  "warning",
  "configWarning",
  "deprecationNotice",
  "thread/started",
  "thread/status/changed",
  "thread/closed",
  "thread/archived",
  "thread/compacted",
  "thread/goal/updated",
  "thread/goal/cleared",
  "thread/readState/changed",
  "thread/tokenUsage/updated",
  "turn/started",
  "turn/completed",
  "turn/diff/updated",
  "turn/plan/updated",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "serverRequest/resolved",
  "account/updated",
  "account/rateLimits/updated",
  "account/login/completed",
  "model/rerouted",
] as const;

export class CodexCodegenError extends Error {}

interface Bundle {
  readonly root: { [name: string]: Schema };
  readonly v2: { [name: string]: Schema };
}

interface MethodEntry {
  readonly method: string;
  readonly params: Schema | undefined;
  readonly result?: Schema;
}

const ANNOTATIONS = new Set(["$schema", "title", "description", "default", "format", "minimum", "minLength", "definitions"]);
const STRUCTURAL = new Set(["$ref", "allOf", "anyOf", "oneOf", "enum", "const", "type", "properties", "required", "additionalProperties", "items"]);

function isObject(value: unknown): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadBundle(schemaPath: string): Bundle {
  const document = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as Json;
  if (!isObject(document) || !isObject(document["definitions"])) throw new CodexCodegenError(`${schemaPath} has no definitions`);
  const definitions = document["definitions"];
  const v2 = definitions["v2"];
  if (!isObject(v2)) throw new CodexCodegenError(`${schemaPath} has no definitions.v2`);
  const root: { [name: string]: Schema } = {};
  for (const [name, schema] of Object.entries(definitions)) if (name !== "v2") root[name] = schema as Schema;
  return { root, v2: v2 as { [name: string]: Schema } };
}

/** The TypeScript name of a definition: v2 names as they are; a root name that a different v2 definition already uses gets a `Root` prefix. */
function namer(bundle: Bundle): (pointer: string) => string {
  return (pointer) => {
    const v2Match = /^#\/definitions\/v2\/([A-Za-z0-9_]+)$/.exec(pointer);
    if (v2Match !== null) return v2Match[1]!;
    const rootMatch = /^#\/definitions\/([A-Za-z0-9_]+)$/.exec(pointer);
    if (rootMatch === null) throw new CodexCodegenError(`unsupported $ref ${pointer}`);
    const name = rootMatch[1]!;
    const twin = bundle.v2[name];
    if (twin !== undefined && canonical(stripSchema(twin)) !== canonical(stripSchema(bundle.root[name]!))) return `Root${name}`;
    return name;
  };
}

function stripSchema(schema: Schema): Json {
  if (!isObject(schema)) return schema;
  const { $schema: _ignored, ...rest } = schema;
  return rest;
}

function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
  return JSON.stringify(value);
}

function resolve(bundle: Bundle, pointer: string): Schema {
  const v2Match = /^#\/definitions\/v2\/([A-Za-z0-9_]+)$/.exec(pointer);
  const schema = v2Match !== null ? bundle.v2[v2Match[1]!] : bundle.root[/^#\/definitions\/([A-Za-z0-9_]+)$/.exec(pointer)?.[1] ?? ""];
  if (schema === undefined) throw new CodexCodegenError(`$ref ${pointer} does not resolve`);
  return schema;
}

function methodsOf(bundle: Bundle, union: string): Map<string, Schema | undefined> {
  const schema = bundle.root[union];
  if (!isObject(schema) || !Array.isArray(schema["oneOf"])) throw new CodexCodegenError(`${union} is not a oneOf union`);
  const methods = new Map<string, Schema | undefined>();
  for (const variant of schema["oneOf"]) {
    if (!isObject(variant) || !isObject(variant["properties"])) continue;
    const method = variant["properties"]["method"];
    if (!isObject(method)) continue;
    const names = Array.isArray(method["enum"]) ? method["enum"] : "const" in method ? [method["const"]] : [];
    const params = variant["properties"]["params"];
    for (const name of names) if (typeof name === "string") methods.set(name, params === undefined ? undefined : (params as Schema));
  }
  return methods;
}

/** The `$ref` of a params schema, also through `anyOf: [ref, null]`. */
function paramsRef(params: Schema | undefined): string | undefined {
  if (!isObject(params)) return undefined;
  if (typeof params["$ref"] === "string") return params["$ref"];
  const options = params["anyOf"];
  if (Array.isArray(options)) {
    const refs = options.filter((option) => isObject(option) && typeof option["$ref"] === "string") as Array<{ $ref: string }>;
    if (refs.length === 1) return refs[0]!.$ref;
  }
  return undefined;
}

function selectMethods(bundle: Bundle, additions: { responseTypes: { [method: string]: string } }): {
  clientRequests: MethodEntry[];
  clientNotifications: MethodEntry[];
  serverRequests: MethodEntry[];
  serverNotifications: MethodEntry[];
} {
  const responseFor = (method: string, params: Schema | undefined): Schema => {
    const override = additions.responseTypes[method];
    if (override !== undefined) {
      const pointer = bundle.v2[override] !== undefined ? `#/definitions/v2/${override}` : `#/definitions/${override}`;
      resolve(bundle, pointer);
      return { $ref: pointer };
    }
    const ref = paramsRef(params);
    if (ref === undefined || !ref.endsWith("Params")) throw new CodexCodegenError(`${method}: cannot name its response type; add it to ${ADDITIONS_FILE}`);
    const pointer = `${ref.slice(0, -"Params".length)}Response`;
    resolve(bundle, pointer);
    return { $ref: pointer };
  };
  const pick = (union: string, names: readonly string[], withResult: boolean): MethodEntry[] => {
    const available = methodsOf(bundle, union);
    return names.map((method) => {
      if (!available.has(method)) throw new CodexCodegenError(`${union} has no method ${method}`);
      const params = available.get(method);
      return withResult ? { method, params, result: responseFor(method, params) } : { method, params };
    });
  };
  return {
    clientRequests: pick("ClientRequest", CLIENT_REQUESTS, true),
    clientNotifications: pick("ClientNotification", CLIENT_NOTIFICATIONS, false),
    serverRequests: pick("ServerRequest", SERVER_REQUESTS, true),
    serverNotifications: pick("ServerNotification", SERVER_NOTIFICATIONS, false),
  };
}

function jsDoc(text: string | undefined, indent: string): string {
  if (text === undefined || text.trim() === "") return "";
  const lines = text.replaceAll("*/", "*\\/").split("\n");
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  return `${indent}/**\n${lines.map((line) => (line === "" ? `${indent} *` : `${indent} * ${line}`)).join("\n")}\n${indent} */\n`;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function propertyKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/** Turns schemas into TypeScript type text and collects the definitions they reach. */
class TypeWriter {
  readonly #bundle: Bundle;
  readonly #name: (pointer: string) => string;
  readonly reached = new Map<string, string>();
  readonly #queue: string[] = [];

  constructor(bundle: Bundle) {
    this.#bundle = bundle;
    this.#name = namer(bundle);
  }

  reference(pointer: string): string {
    const name = this.#name(pointer);
    if (!this.reached.has(pointer)) {
      this.reached.set(pointer, name);
      this.#queue.push(pointer);
    }
    return name;
  }

  nextPending(): string | undefined {
    return this.#queue.shift();
  }

  type(schema: Schema, indent: string, where: string): string {
    if (schema === true) return "unknown";
    if (schema === false) return "never";
    for (const keyword of Object.keys(schema)) {
      if (!ANNOTATIONS.has(keyword) && !STRUCTURAL.has(keyword)) throw new CodexCodegenError(`${where}: unsupported keyword ${keyword}`);
    }
    if (typeof schema["$ref"] === "string") return this.reference(schema["$ref"]);
    if (Array.isArray(schema["enum"])) return schema["enum"].map((value) => JSON.stringify(value)).join(" | ");
    if ("const" in schema) return JSON.stringify(schema["const"]);
    const parts: string[] = [];
    const base = this.#base(schema, indent, where);
    if (base !== undefined) parts.push(base);
    if (Array.isArray(schema["allOf"])) {
      const members = schema["allOf"].map((member, index) => this.type(member as Schema, indent, `${where}/allOf/${index}`));
      parts.push(...members.map((member) => (members.length > 1 || parts.length > 0 ? `(${member})` : member)));
    }
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const options = schema[keyword];
      if (!Array.isArray(options)) continue;
      // Branches that only list `required` constrain the object; they add no shape.
      if (options.every((option) => isObject(option) && Object.keys(option).every((key) => key === "required" || ANNOTATIONS.has(key)))) continue;
      const union = options.map((option, index) => this.type(option as Schema, indent, `${where}/${keyword}/${index}`)).join(" | ");
      parts.push(parts.length > 0 ? `(${union})` : union);
    }
    if (parts.length === 0) return "unknown";
    return parts.join(" & ");
  }

  #base(schema: { [keyword: string]: Json }, indent: string, where: string): string | undefined {
    const type = schema["type"];
    if (Array.isArray(type)) {
      const { type: _types, ...rest } = schema;
      return type.map((single) => this.#base({ ...rest, type: single }, indent, where) ?? "unknown").join(" | ");
    }
    if (type === "string") return "string";
    if (type === "integer" || type === "number") return "number";
    if (type === "boolean") return "boolean";
    if (type === "null") return "null";
    if (type === "array") {
      const items = schema["items"];
      if (items === undefined) return "unknown[]";
      const item = this.type(items as Schema, indent, `${where}/items`);
      return /^[A-Za-z0-9_]+$/.test(item) ? `${item}[]` : `Array<${item}>`;
    }
    if (type === "object" || isObject(schema["properties"])) return this.#object(schema, indent, where);
    if (type !== undefined) throw new CodexCodegenError(`${where}: unsupported type ${JSON.stringify(type)}`);
    return undefined;
  }

  #object(schema: { [keyword: string]: Json }, indent: string, where: string): string {
    const properties = isObject(schema["properties"]) ? schema["properties"] : {};
    const required = new Set(Array.isArray(schema["required"]) ? schema["required"].filter((name): name is string => typeof name === "string") : []);
    const inner = `${indent}  `;
    const lines: string[] = [];
    for (const [name, property] of Object.entries(properties)) {
      const description = isObject(property) && typeof property["description"] === "string" ? property["description"] : undefined;
      lines.push(`${jsDoc(description, inner)}${inner}${propertyKey(name)}${required.has(name) ? "" : "?"}: ${this.type(property as Schema, inner, `${where}/properties/${name}`)};`);
    }
    const extra = schema["additionalProperties"];
    let index: string | undefined;
    if (extra === true || (isObject(extra) && Object.keys(extra).length === 0)) index = "unknown";
    else if (isObject(extra)) index = this.type(extra as Schema, inner, `${where}/additionalProperties`);
    else if (extra === undefined && lines.length === 0) index = "unknown";
    const shape = lines.length === 0 ? undefined : `{\n${lines.join("\n")}\n${indent}}`;
    const map = index === undefined ? undefined : `{ [key: string]: ${index} }`;
    if (shape !== undefined && map !== undefined) return `${shape} & ${map}`;
    return shape ?? map ?? "{}";
  }
}

function methodTypeName(method: string, suffix: string): string {
  return `${method
    .split(/[/_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")}${suffix}`;
}

function camelMethod(method: string): string {
  const pascal = methodTypeName(method, "");
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** The generated module's text. */
export function generateCodexProtocol(schemaDir: string): string {
  const bundle = loadBundle(path.join(schemaDir, SCHEMA_FILE));
  const additionsPath = path.join(schemaDir, ADDITIONS_FILE);
  const additions = fs.existsSync(additionsPath) ? (JSON.parse(fs.readFileSync(additionsPath, "utf8")) as { responseTypes: { [method: string]: string } }) : { responseTypes: {} };
  const selected = selectMethods(bundle, additions);
  const writer = new TypeWriter(bundle);

  const mapEntry = (entry: MethodEntry, withResult: boolean): string => {
    const params = entry.params === undefined ? "undefined" : writer.type(entry.params, "    ", `${entry.method}/params`);
    if (!withResult) return `  ${JSON.stringify(entry.method)}: ${params};`;
    const result = writer.type(entry.result!, "    ", `${entry.method}/result`);
    return `  ${JSON.stringify(entry.method)}: { params: ${params}; result: ${result} };`;
  };
  const clientRequestMap = selected.clientRequests.map((entry) => mapEntry(entry, true));
  const clientNotificationMap = selected.clientNotifications.map((entry) => mapEntry(entry, false));
  const serverRequestMap = selected.serverRequests.map((entry) => mapEntry(entry, true));
  const serverNotificationMap = selected.serverNotifications.map((entry) => mapEntry(entry, false));

  const definitions: string[] = [];
  for (let pointer = writer.nextPending(); pointer !== undefined; pointer = writer.nextPending()) {
    const name = writer.reached.get(pointer)!;
    const schema = resolve(bundle, pointer);
    const description = isObject(schema) && typeof schema["description"] === "string" ? schema["description"] : undefined;
    definitions.push(`${jsDoc(description, "")}export type ${name} = ${writer.type(schema, "", pointer)};\n`);
  }
  definitions.sort((a, b) => definitionName(a).localeCompare(definitionName(b)));

  const clientMethods = selected.clientRequests.map((entry) => {
    const name = camelMethod(entry.method);
    const params = entry.params === undefined ? "" : `params: CodexClientRequestMap[${JSON.stringify(entry.method)}]["params"]`;
    const argument = entry.params === undefined ? "undefined" : "params";
    return `  /** \`${entry.method}\` */\n  ${name}(${params}): Promise<CodexClientRequestMap[${JSON.stringify(entry.method)}]["result"]> {\n    return this.#transport.request(${JSON.stringify(entry.method)}, ${argument}) as Promise<CodexClientRequestMap[${JSON.stringify(entry.method)}]["result"]>;\n  }`;
  });

  const list = (values: readonly string[]): string => `[\n${values.map((value) => `  ${JSON.stringify(value)},`).join("\n")}\n]`;

  return `// GENERATED by scripts/codegen-codex.ts from
// vendor-schemas/codex/${CODEX_SOURCE.commit}/${SCHEMA_FILE}
// (${CODEX_SOURCE.repository}, ${CODEX_SOURCE.tag}, commit ${CODEX_SOURCE.commit}).
// Do not edit: run \`pnpm run codegen\`; \`pnpm run codegen:codex:check\` fails when this file is stale.
//
// Types for the Codex app-server JSON-RPC protocol as far as the Codex driver
// uses it, a map from each method to its params and result, and a client with
// one method per request. Codex frames carry no "jsonrpc" member.

/** The upstream source this file was generated from. */
export const CODEX_PROTOCOL_SOURCE = ${JSON.stringify(CODEX_SOURCE, null, 2).replaceAll("\n", "\n")} as const;

/** Requests the client sends, by method. */
export interface CodexClientRequestMap {
${clientRequestMap.join("\n")}
}

/** Notifications the client sends, by method, with their params. */
export interface CodexClientNotificationMap {
${clientNotificationMap.join("\n")}
}

/** Requests the server sends, by method. */
export interface CodexServerRequestMap {
${serverRequestMap.join("\n")}
}

/** Notifications the server sends, by method, with their params. */
export interface CodexServerNotificationMap {
${serverNotificationMap.join("\n")}
}

export type CodexClientRequestMethod = keyof CodexClientRequestMap;
export type CodexServerRequestMethod = keyof CodexServerRequestMap;
export type CodexServerNotificationMethod = keyof CodexServerNotificationMap;
export type CodexClientNotificationMethod = keyof CodexClientNotificationMap;

export const CODEX_CLIENT_REQUEST_METHODS: readonly CodexClientRequestMethod[] = ${list(CLIENT_REQUESTS)};
export const CODEX_CLIENT_NOTIFICATION_METHODS: readonly CodexClientNotificationMethod[] = ${list(CLIENT_NOTIFICATIONS)};
export const CODEX_SERVER_REQUEST_METHODS: readonly CodexServerRequestMethod[] = ${list(SERVER_REQUESTS)};
export const CODEX_SERVER_NOTIFICATION_METHODS: readonly CodexServerNotificationMethod[] = ${list(SERVER_NOTIFICATIONS)};

/** What the client needs from a JSON-RPC connection. */
export interface CodexTransport {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
}

/** A typed client for the requests and notifications the client sends. */
export class CodexAppServerClient {
  readonly #transport: CodexTransport;

  constructor(transport: CodexTransport) {
    this.#transport = transport;
  }

  /** Sends a request by method name, typed by the method map. */
  request<Method extends CodexClientRequestMethod>(method: Method, params: CodexClientRequestMap[Method]["params"]): Promise<CodexClientRequestMap[Method]["result"]> {
    return this.#transport.request(method, params) as Promise<CodexClientRequestMap[Method]["result"]>;
  }

  /** \`initialized\` */
  initialized(): Promise<void> {
    return this.#transport.notify("initialized");
  }

${clientMethods.join("\n\n")}
}

${definitions.join("\n")}`;
}

function definitionName(text: string): string {
  return /export type ([A-Za-z0-9_]+) =/.exec(text)?.[1] ?? "";
}

function main(argv: string[]): number {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const option = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const schemaDir = path.resolve(option("--schema-dir") ?? path.join(root, "vendor-schemas", "codex", CODEX_SOURCE.commit));
  const out = path.resolve(option("--out") ?? path.join(root, OUTPUT_FILE));
  let text: string;
  try {
    text = generateCodexProtocol(schemaDir);
  } catch (error) {
    process.stderr.write(`codegen-codex failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (argv.includes("--check")) {
    const current = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : undefined;
    if (current !== text) {
      process.stderr.write(`codegen:codex:check failed: ${path.relative(root, out)} ${current === undefined ? "is missing" : "differs from what the vendored Codex schema generates"}. Run \`pnpm run codegen\`.\n`);
      return 1;
    }
    process.stdout.write("codegen:codex:check passed: the Codex protocol client matches the vendored schema.\n");
    return 0;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  process.stdout.write(`codegen-codex wrote ${path.relative(root, out)}\n`);
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
