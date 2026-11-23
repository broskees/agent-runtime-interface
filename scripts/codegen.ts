// Generates, from the normative JSON Schema in spec/v1:
//   - src/generated/<file>.ts: TypeScript types plus one Standard Schema
//     validator per definition, one module per schema file;
//   - json-schema/<file>: the published copies, plus methods.json.
//
// Usage:
//   node scripts/codegen.ts            write the generated files
//   node scripts/codegen.ts --check    exit 1 if any generated file is stale
//   --root <dir>                       run against another checkout (tests use it)
//
// Codegen only accepts the JSON Schema subset listed in ALLOWED_KEYWORDS, so the
// interpreter in src/validation.ts covers everything the spec can say.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const SPEC_BASE_ID = "https://ari.invalid/spec/v1/";
export const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

export const ANNOTATION_KEYWORDS = ["$schema", "$id", "$defs", "$comment", "title", "description", "examples", "default", "deprecated"];
const APPLICATOR_KEYWORDS = ["$ref", "allOf", "anyOf", "oneOf", "not", "properties", "additionalProperties", "items", "prefixItems"];
const VALIDATION_KEYWORDS = [
  "type",
  "enum",
  "const",
  "required",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
];
const ALLOWED_KEYWORDS = new Set([...ANNOTATION_KEYWORDS, ...APPLICATOR_KEYWORDS, ...VALIDATION_KEYWORDS]);
export const EXTENSION_PATTERN = "^x:";
const REF_PATTERN = /^([^#]*)#\/\$defs\/([A-Za-z_][A-Za-z0-9_]*)$/;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type SchemaObject = { [keyword: string]: Json };

export interface SpecFile {
  /** Path relative to spec/v1, with forward slashes, e.g. `extensions/ari.goal.schema.json`. */
  readonly relPath: string;
  /** Module path relative to src/generated without extension, e.g. `extensions/ari.goal`. */
  readonly modulePath: string;
  readonly documentConst: string;
  readonly document: SchemaObject;
  readonly defs: Map<string, Json>;
}

export interface DefLocation {
  readonly file: SpecFile;
  readonly name: string;
}

export class CodegenError extends Error {}

function fail(message: string): never {
  throw new CodegenError(message);
}

export function listFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...listFiles(full));
    else results.push(full);
  }
  return results.sort();
}

export function toPosix(relative: string): string {
  return relative.split(path.sep).join("/");
}

export function isSchemaObject(value: Json | undefined): value is SchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function camelCase(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter((word) => word !== "");
  return words.map((word, index) => (index === 0 ? word.toLowerCase() : word[0]!.toUpperCase() + word.slice(1))).join("");
}

export function loadSpec(specDir: string): SpecFile[] {
  const files: SpecFile[] = [];
  for (const full of listFiles(specDir)) {
    const relPath = toPosix(path.relative(specDir, full));
    if (!relPath.endsWith(".schema.json")) continue;
    let document: Json;
    try {
      document = JSON.parse(fs.readFileSync(full, "utf8")) as Json;
    } catch (error) {
      fail(`spec/v1/${relPath}: invalid JSON (${(error as Error).message})`);
    }
    if (!isSchemaObject(document)) fail(`spec/v1/${relPath}: the root must be an object`);
    if (document.$schema !== DRAFT_2020_12) fail(`spec/v1/${relPath}: "$schema" must be "${DRAFT_2020_12}"`);
    if (document.$id !== SPEC_BASE_ID + relPath) fail(`spec/v1/${relPath}: "$id" must be "${SPEC_BASE_ID + relPath}"`);
    const defsNode = document.$defs;
    if (!isSchemaObject(defsNode)) fail(`spec/v1/${relPath}: "$defs" must be an object`);
    const modulePath = relPath.slice(0, -".schema.json".length);
    files.push({
      relPath,
      modulePath,
      documentConst: `${camelCase(path.posix.basename(modulePath))}Document`,
      document,
      defs: new Map(Object.entries(defsNode)),
    });
  }
  if (files.length === 0) fail(`no *.schema.json files under ${specDir}`);
  return files;
}

function checkKeywords(file: SpecFile, node: Json, where: string): void {
  if (typeof node === "boolean") return;
  if (!isSchemaObject(node)) fail(`spec/v1/${file.relPath} ${where}: a schema must be an object or a boolean`);
  for (const [keyword, value] of Object.entries(node)) {
    if (!ALLOWED_KEYWORDS.has(keyword)) {
      fail(`spec/v1/${file.relPath} ${where}: keyword "${keyword}" is outside the subset codegen supports`);
    }
    if (keyword === "$defs" || keyword === "properties") {
      if (!isSchemaObject(value)) fail(`spec/v1/${file.relPath} ${where}/${keyword}: must be an object`);
      for (const [name, child] of Object.entries(value)) checkKeywords(file, child, `${where}/${keyword}/${name}`);
    } else if (keyword === "additionalProperties" || keyword === "items" || keyword === "not") {
      checkKeywords(file, value, `${where}/${keyword}`);
    } else if (keyword === "allOf" || keyword === "anyOf" || keyword === "oneOf" || keyword === "prefixItems") {
      if (!Array.isArray(value)) fail(`spec/v1/${file.relPath} ${where}/${keyword}: must be an array`);
      value.forEach((child, index) => checkKeywords(file, child, `${where}/${keyword}/${index}`));
    } else if (keyword === "pattern" && typeof value === "string") {
      new RegExp(value, "u");
    }
  }
}

function forEachRef(node: Json, visit: (ref: string) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) forEachRef(child, visit);
    return;
  }
  if (!isSchemaObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") visit(value);
    else forEachRef(value, visit);
  }
}

export class SpecModel {
  readonly files: SpecFile[];
  readonly filesByRelPath: Map<string, SpecFile>;
  readonly defOwners = new Map<string, SpecFile>();

  constructor(files: SpecFile[]) {
    this.files = files;
    this.filesByRelPath = new Map(files.map((file) => [file.relPath, file]));
    const documentConsts = new Set<string>();
    for (const file of files) {
      checkKeywords(file, file.document, "#");
      if (documentConsts.has(file.documentConst)) fail(`two schema files map to the same module name ${file.documentConst}`);
      documentConsts.add(file.documentConst);
      for (const name of file.defs.keys()) {
        if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) fail(`spec/v1/${file.relPath}: definition "${name}" must be PascalCase`);
        const owner = this.defOwners.get(name);
        if (owner !== undefined) {
          fail(`definition "${name}" is defined in both spec/v1/${owner.relPath} and spec/v1/${file.relPath}; names must be unique`);
        }
        this.defOwners.set(name, file);
      }
    }
    for (const name of this.defOwners.keys()) {
      if (this.defOwners.has(`${name}Schema`)) fail(`definitions "${name}" and "${name}Schema" would collide in generated code`);
    }
    for (const file of files) forEachRef(file.document, (ref) => this.resolveRef(file, ref));
  }

  resolveRef(from: SpecFile, ref: string): DefLocation {
    const match = REF_PATTERN.exec(ref);
    if (match === null) fail(`spec/v1/${from.relPath}: reference "${ref}" must have the form "[file]#/$defs/Name"`);
    const [, filePart = "", name = ""] = match;
    const targetRelPath = filePart === "" ? from.relPath : path.posix.normalize(path.posix.join(path.posix.dirname(from.relPath), filePart));
    const file = this.filesByRelPath.get(targetRelPath);
    if (file === undefined) fail(`spec/v1/${from.relPath}: reference "${ref}" names a missing file spec/v1/${targetRelPath}`);
    if (!file.defs.has(name)) fail(`spec/v1/${from.relPath}: reference "${ref}" names a missing definition`);
    return { file, name };
  }

  directDependencies(file: SpecFile): Set<SpecFile> {
    const dependencies = new Set<SpecFile>();
    forEachRef(file.document, (ref) => {
      const target = this.resolveRef(file, ref).file;
      if (target !== file) dependencies.add(target);
    });
    return dependencies;
  }

  transitiveDependencies(file: SpecFile): SpecFile[] {
    const seen = new Set<SpecFile>([file]);
    const queue = [file];
    while (queue.length > 0) {
      const next = queue.shift()!;
      for (const dependency of this.directDependencies(next)) {
        if (!seen.has(dependency)) {
          seen.add(dependency);
          queue.push(dependency);
        }
      }
    }
    seen.delete(file);
    return [...seen].sort((left, right) => left.relPath.localeCompare(right.relPath));
  }
}

// ---------------------------------------------------------------------------
// TypeScript printing

interface ModuleContext {
  readonly model: SpecModel;
  readonly file: SpecFile;
  readonly typeImports: Map<SpecFile, Set<string>>;
}

export function jsDoc(description: Json | undefined, indent: string): string {
  if (typeof description !== "string" || description === "") return "";
  const text = description.replaceAll("*/", "*\\/");
  const lines = text.split("\n");
  if (lines.length === 1) return `${indent}/** ${text} */\n`;
  return `${indent}/**\n${lines.map((line) => `${indent} * ${line}`.trimEnd()).join("\n")}\n${indent} */\n`;
}

function literal(value: Json): string {
  return JSON.stringify(value);
}

export function propertyKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

export function isAnnotationOnly(node: SchemaObject): boolean {
  return Object.keys(node).every((key) => ANNOTATION_KEYWORDS.includes(key));
}

function isPlainString(node: Json): boolean {
  if (!isSchemaObject(node) || node.type !== "string") return false;
  return Object.keys(node).every((key) => key === "type" || ANNOTATION_KEYWORDS.includes(key));
}

export function isRequiredOnlyUnion(members: Json[]): boolean {
  return members.every((member) => isSchemaObject(member) && Object.keys(member).every((key) => key === "required"));
}

function needsParens(expression: string): boolean {
  let depth = 0;
  for (let index = 0; index < expression.length; index++) {
    const char = expression[index];
    if (char === "{" || char === "(" || char === "[" || char === "<") depth++;
    else if (char === "}" || char === ")" || char === "]" || char === ">") depth--;
    else if (depth === 0 && (char === "|" || char === "&")) return true;
  }
  return false;
}

function wrap(expression: string): string {
  return needsParens(expression) ? `(${expression})` : expression;
}

function refName(ctx: ModuleContext, ref: string): string {
  const target = ctx.model.resolveRef(ctx.file, ref);
  if (target.file !== ctx.file) {
    let names = ctx.typeImports.get(target.file);
    if (names === undefined) {
      names = new Set();
      ctx.typeImports.set(target.file, names);
    }
    names.add(target.name);
  }
  return target.name;
}

function typeExpression(ctx: ModuleContext, node: Json, indent: string): string {
  if (node === true) return "unknown";
  if (node === false) return "never";
  if (!isSchemaObject(node)) fail(`spec/v1/${ctx.file.relPath}: unexpected schema node ${JSON.stringify(node)}`);
  if (isAnnotationOnly(node)) return "unknown";
  if (typeof node.$ref === "string") return refName(ctx, node.$ref);
  if (node.const !== undefined) return literal(node.const);
  if (Array.isArray(node.enum)) return node.enum.map(literal).join(" | ");
  if (Array.isArray(node.allOf)) return node.allOf.map((member) => wrap(typeExpression(ctx, member, indent))).join(" & ");
  const union = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined;
  if (union !== undefined && !isRequiredOnlyUnion(union)) {
    if (node.type !== undefined || node.properties !== undefined) {
      fail(`spec/v1/${ctx.file.relPath}: a schema cannot combine "type" or "properties" with a union other than required-field alternatives`);
    }
    const hasOtherMembers = union.length > 1;
    return union
      .map((member) => (hasOtherMembers && isPlainString(member) ? "(string & {})" : typeExpression(ctx, member, indent)))
      .join(" | ");
  }
  if (Array.isArray(node.type)) {
    return node.type.map((type) => singleType(ctx, node, String(type), indent)).join(" | ");
  }
  if (typeof node.type === "string") return singleType(ctx, node, node.type, indent);
  if (node.properties !== undefined || node.additionalProperties !== undefined) return objectType(ctx, node, indent);
  return "unknown";
}

function singleType(ctx: ModuleContext, node: SchemaObject, type: string, indent: string): string {
  switch (type) {
    case "string":
      return node.pattern === EXTENSION_PATTERN ? "`x:${string}`" : "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      if (Array.isArray(node.prefixItems)) {
        return `[${node.prefixItems.map((item) => typeExpression(ctx, item, indent)).join(", ")}]`;
      }
      if (node.items !== undefined) return `${wrap(typeExpression(ctx, node.items, indent))}[]`;
      return "unknown[]";
    }
    case "object":
      return objectType(ctx, node, indent);
    default:
      fail(`spec/v1/${ctx.file.relPath}: unknown type "${type}"`);
  }
}

function objectType(ctx: ModuleContext, node: SchemaObject, indent: string): string {
  const properties = isSchemaObject(node.properties) ? node.properties : undefined;
  const additional = node.additionalProperties;
  if (properties === undefined || Object.keys(properties).length === 0) {
    if (additional === undefined || additional === true) return "{ [key: string]: unknown }";
    return `{ [key: string]: ${typeExpression(ctx, additional, indent)} }`;
  }
  if (additional !== undefined && additional !== true) {
    fail(`spec/v1/${ctx.file.relPath}: an object with properties cannot restrict additionalProperties`);
  }
  const required = new Set(Array.isArray(node.required) ? node.required.map(String) : []);
  const inner = `${indent}  `;
  const lines = Object.entries(properties).map(([name, schema]) => {
    const doc = isSchemaObject(schema) ? jsDoc(schema.description, inner) : "";
    const optional = required.has(name) ? "" : "?";
    return `${doc}${inner}${propertyKey(name)}${optional}: ${typeExpression(ctx, schema, inner)};`;
  });
  const base = `{\n${lines.join("\n")}\n${indent}}`;
  const alternatives = requiredAlternatives(ctx, node, properties, indent);
  return alternatives === undefined ? base : `${base} & (${alternatives})`;
}

// An `anyOf` whose branches only list `required` fields ("at least one of
// these") becomes a union of objects that each require their fields, so the
// TypeScript type rejects exactly what the schema rejects, for example a
// `driver_unavailable` error that names neither a package nor a binary.
function requiredAlternatives(ctx: ModuleContext, node: SchemaObject, properties: SchemaObject, indent: string): string | undefined {
  const union = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined;
  if (union === undefined || !isRequiredOnlyUnion(union)) return undefined;
  return union
    .map((branch) => {
      const names = ((branch as SchemaObject).required as Json[]).map(String);
      if (names.length === 0) fail(`spec/v1/${ctx.file.relPath}: a required-field alternative must name at least one field`);
      const fields = names.map((name) => {
        const schema = properties[name];
        if (schema === undefined) fail(`spec/v1/${ctx.file.relPath}: required-field alternative names "${name}", which is not a property`);
        return `${propertyKey(name)}: ${typeExpression(ctx, schema, indent)}`;
      });
      return `{ ${fields.join("; ")} }`;
    })
    .join(" | ");
}

function relativeModule(from: SpecFile, to: SpecFile): string {
  const relative = path.posix.relative(path.posix.dirname(from.modulePath), to.modulePath);
  return `${relative.startsWith(".") ? relative : `./${relative}`}.ts`;
}

function generateModule(model: SpecModel, file: SpecFile): string {
  const ctx: ModuleContext = { model, file, typeImports: new Map() };
  const declarations: string[] = [];
  const validators: string[] = [];
  for (const [name, schema] of file.defs) {
    const doc = isSchemaObject(schema) ? jsDoc(schema.description, "") : "";
    declarations.push(`${doc}export type ${name} = ${typeExpression(ctx, schema, "")};`);
    validators.push(
      `export const ${name}Schema: Validator<${name}> = /* @__PURE__ */ createValidator<${name}>(${literal(name)}, ${literal(file.document.$id ?? null)}, documents);`,
    );
  }

  const depth = file.modulePath.split("/").length - 1;
  const validationModule = `${"../".repeat(depth + 1)}validation.ts`;
  const documentDependencies = model.transitiveDependencies(file);

  const header = [
    `// Generated by scripts/codegen.ts from spec/v1/${file.relPath}. Do not edit.`,
    `// Change the schema and run \`pnpm run codegen\` instead.`,
    "",
    `import { createValidator } from ${literal(validationModule)};`,
    `import type { SchemaDocument, Validator } from ${literal(validationModule)};`,
  ];
  for (const dependency of documentDependencies) {
    header.push(`import { ${dependency.documentConst} } from ${literal(relativeModule(file, dependency))};`);
  }
  const typeImportFiles = [...ctx.typeImports.keys()].sort((left, right) => left.relPath.localeCompare(right.relPath));
  for (const dependency of typeImportFiles) {
    const names = [...ctx.typeImports.get(dependency)!].sort();
    header.push(`import type { ${names.join(", ")} } from ${literal(relativeModule(file, dependency))};`);
  }

  const documentLiteral = JSON.stringify(file.document, null, 2);
  const documentList = [file.documentConst, ...documentDependencies.map((dependency) => dependency.documentConst)].join(", ");
  return [
    header.join("\n"),
    declarations.join("\n\n"),
    `/** The schema document spec/v1/${file.relPath}, embedded for the validators. */\nexport const ${file.documentConst}: SchemaDocument = ${documentLiteral};`,
    `const documents = (): readonly SchemaDocument[] => [${documentList}];`,
    validators.join("\n"),
  ].join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// Methods table: every $ref must resolve into spec/v1.

function checkMethodTable(model: SpecModel, specDir: string): string | undefined {
  const methodsPath = path.join(specDir, "methods.json");
  if (!fs.existsSync(methodsPath)) return undefined;
  const text = fs.readFileSync(methodsPath, "utf8");
  let table: Json;
  try {
    table = JSON.parse(text) as Json;
  } catch (error) {
    fail(`spec/v1/methods.json: invalid JSON (${(error as Error).message})`);
  }
  const root: SpecFile = { relPath: "methods.json", modulePath: "methods", documentConst: "", document: {}, defs: new Map() };
  forEachRef(table, (ref) => {
    if (ref.startsWith("#")) fail(`spec/v1/methods.json: reference "${ref}" must name a schema file`);
    model.resolveRef(root, ref);
  });
  return JSON.stringify(table, null, 2) + "\n";
}

// ---------------------------------------------------------------------------

/** Every generated file, keyed by path relative to `root`. */
export function generate(root: string): Map<string, string> {
  const specDir = path.join(root, "spec", "v1");
  const model = new SpecModel(loadSpec(specDir));
  const outputs = new Map<string, string>();
  for (const file of model.files) {
    outputs.set(`src/generated/${file.modulePath}.ts`, generateModule(model, file));
    outputs.set(`json-schema/${file.relPath}`, JSON.stringify(file.document, null, 2) + "\n");
  }
  const methods = checkMethodTable(model, specDir);
  if (methods !== undefined) outputs.set("json-schema/methods.json", methods);
  return outputs;
}

function existingGeneratedFiles(root: string): string[] {
  return [path.join(root, "src", "generated"), path.join(root, "json-schema")]
    .flatMap((directory) => listFiles(directory))
    .map((full) => toPosix(path.relative(root, full)));
}

/** Paths that differ from what codegen would write, are missing, or should not exist. */
export function findDrift(root: string): string[] {
  const outputs = generate(root);
  const drift: string[] = [];
  for (const [relative, content] of outputs) {
    const full = path.join(root, relative);
    if (!fs.existsSync(full)) drift.push(`${relative} is missing`);
    else if (fs.readFileSync(full, "utf8") !== content) drift.push(`${relative} differs from the spec`);
  }
  for (const relative of existingGeneratedFiles(root)) {
    if (!outputs.has(relative)) drift.push(`${relative} is not produced by codegen`);
  }
  return drift;
}

export function writeGenerated(root: string): void {
  const outputs = generate(root);
  for (const relative of existingGeneratedFiles(root)) {
    if (!outputs.has(relative)) fs.rmSync(path.join(root, relative));
  }
  for (const [relative, content] of outputs) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (!fs.existsSync(full) || fs.readFileSync(full, "utf8") !== content) fs.writeFileSync(full, content);
  }
}

function main(argv: string[]): number {
  const check = argv.includes("--check");
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex === -1 ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") : path.resolve(argv[rootIndex + 1] ?? ".");
  try {
    if (check) {
      const drift = findDrift(root);
      if (drift.length > 0) {
        process.stderr.write(`codegen:check failed. Run \`pnpm run codegen\`.\n${drift.map((line) => `  ${line}`).join("\n")}\n`);
        return 1;
      }
      process.stdout.write("codegen:check passed: generated files match spec/v1.\n");
      return 0;
    }
    writeGenerated(root);
    process.stdout.write("codegen wrote src/generated and json-schema from spec/v1.\n");
    return 0;
  } catch (error) {
    if (error instanceof CodegenError) {
      process.stderr.write(`codegen failed: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
