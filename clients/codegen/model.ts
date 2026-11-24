// The wire model the three client generators share: every definition of
// json-schema/*.json and every method of spec/v1/methods.json, reduced to a
// handful of shapes each language can print.
//
//   struct    an object with named fields. `allOf` members are merged into
//             one struct; an `anyOf` of `required`-only branches ("at least
//             one of these") adds no type. A `const` property is the
//             struct's tag (its discriminator value).
//   enum      a set of known strings. Every enum is open: a value the client
//             does not know is kept, never refused.
//   union     a `oneOf` whose members carry one `const` discriminator. A
//             member whose discriminator is not a `const` (an `x:` extension
//             form) has no variant of its own: it, and any discriminator
//             value a newer ARI adds, land in the union's catch-all with the
//             raw JSON.
//   untagged  an `anyOf` of other types with no discriminator.
//   alias     anything else that has a name: a nullable, a list, a string.
//
// Inline object, enum and union schemas get names of their own: the parent's
// name plus the property's (`ConfigChangePlan` + `apply_now` gives
// `ConfigChangePlanApplyNow`). The generators never invent other names.

import * as fs from "node:fs";
import * as path from "node:path";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Node = { [keyword: string]: Json };

export type TypeRef =
  | { readonly kind: "any" }
  | { readonly kind: "null" }
  | { readonly kind: "string" }
  | { readonly kind: "integer" }
  | { readonly kind: "number" }
  | { readonly kind: "boolean" }
  | { readonly kind: "ref"; readonly name: string }
  | { readonly kind: "array"; readonly items: TypeRef }
  | { readonly kind: "tuple"; readonly items: readonly TypeRef[] }
  | { readonly kind: "map"; readonly values: TypeRef }
  | { readonly kind: "nullable"; readonly inner: TypeRef };

export interface Field {
  /** The property name on the wire. */
  readonly json: string;
  readonly type: TypeRef;
  readonly required: boolean;
  readonly description: string | undefined;
}

export interface StructDecl {
  readonly kind: "struct";
  readonly name: string;
  readonly description: string | undefined;
  /** Every field but the tag. */
  readonly fields: readonly Field[];
  /** The `const` property, when the struct has one: `{ field: "type", value: "session.state" }`. */
  readonly tag: { readonly field: string; readonly value: string } | undefined;
}

export interface EnumDecl {
  readonly kind: "enum";
  readonly name: string;
  readonly description: string | undefined;
  readonly values: readonly string[];
}

export interface UnionDecl {
  readonly kind: "union";
  readonly name: string;
  readonly description: string | undefined;
  /** The discriminating property, such as `type` or `code`. */
  readonly discriminator: string;
  /** The members with a `const` discriminator, each a struct whose tag is `value`. */
  readonly variants: ReadonlyArray<{ readonly value: string; readonly struct: string }>;
}

export interface UntaggedDecl {
  readonly kind: "untagged";
  readonly name: string;
  readonly description: string | undefined;
  readonly variants: readonly TypeRef[];
}

export interface AliasDecl {
  readonly kind: "alias";
  readonly name: string;
  readonly description: string | undefined;
  readonly type: TypeRef;
}

export type Decl = StructDecl | EnumDecl | UnionDecl | UntaggedDecl | AliasDecl;

export interface MethodModel {
  readonly name: string;
  readonly direction: "host_to_driver" | "driver_to_host" | "both";
  readonly kind: "request" | "notification";
  readonly params: string;
  /** Undefined for notifications. */
  readonly result: string | undefined;
  readonly version: { readonly major: number; readonly minor: number };
  /** For a method that starts a stream: the notification that carries each item, and the item's type. */
  readonly stream: { readonly notification: string; readonly item: string } | undefined;
  readonly optional: boolean;
  readonly description: string | undefined;
}

export interface WireModel {
  /** Every declaration, in a stable order (schema file, then definition order, inline types after their parent). */
  readonly decls: readonly Decl[];
  readonly byName: ReadonlyMap<string, Decl>;
  readonly methods: readonly MethodModel[];
  readonly ariVersion: string;
  /** The inputs, relative to the repository root, for generated headers. */
  readonly sources: readonly string[];
}

export class ModelError extends Error {}

function fail(message: string): never {
  throw new ModelError(message);
}

function isNode(value: Json | undefined): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listSchemaFiles(directory: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...listSchemaFiles(full));
    else if (entry.name.endsWith(".schema.json")) results.push(full);
  }
  return results.sort();
}

/** `apply_next_turn`, `session.state` or `resource_link` as `ApplyNextTurn`, `SessionState`, `ResourceLink`. */
export function pascalCase(text: string): string {
  return text
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "")
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join("");
}

const ANNOTATIONS = new Set(["$schema", "$id", "$defs", "$comment", "title", "description", "examples", "default", "deprecated"]);
/** Keywords that constrain values without changing their type in the generated code. */
const CONSTRAINTS = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems", "pattern"]);

function isAnnotationOnly(node: Node): boolean {
  return Object.keys(node).every((key) => ANNOTATIONS.has(key));
}

function description(node: Json | undefined): string | undefined {
  return isNode(node) && typeof node.description === "string" && node.description !== "" ? node.description : undefined;
}

interface SchemaFile {
  readonly relPath: string;
  readonly defs: Map<string, Json>;
}

class Builder {
  readonly files = new Map<string, SchemaFile>();
  readonly owners = new Map<string, SchemaFile>();
  readonly decls: Decl[] = [];
  readonly byName = new Map<string, Decl>();

  constructor(schemaDir: string) {
    for (const full of listSchemaFiles(schemaDir)) {
      const relPath = path.relative(schemaDir, full).split(path.sep).join("/");
      const document = JSON.parse(fs.readFileSync(full, "utf8")) as Json;
      if (!isNode(document) || !isNode(document.$defs)) fail(`${relPath}: no $defs`);
      const file: SchemaFile = { relPath, defs: new Map(Object.entries(document.$defs)) };
      this.files.set(relPath, file);
      for (const name of file.defs.keys()) {
        if (this.owners.has(name)) fail(`definition ${name} appears in ${this.owners.get(name)!.relPath} and ${relPath}`);
        this.owners.set(name, file);
      }
    }
  }

  /** The definition a `$ref` names, from the file `from`. */
  resolve(from: SchemaFile, ref: string): { file: SchemaFile; name: string; node: Json } {
    const match = /^([^#]*)#\/\$defs\/([A-Za-z0-9_]+)$/.exec(ref);
    if (match === null) fail(`${from.relPath}: unsupported reference ${ref}`);
    const target = match[1] === "" ? from.relPath : path.posix.normalize(path.posix.join(path.posix.dirname(from.relPath), match[1]!));
    const file = this.files.get(target) ?? fail(`${from.relPath}: ${ref} names a missing file`);
    const node = file.defs.get(match[2]!);
    if (node === undefined) fail(`${from.relPath}: ${ref} names a missing definition`);
    return { file, name: match[2]!, node };
  }

  add(decl: Decl): void {
    if (this.byName.has(decl.name)) fail(`two declarations are named ${decl.name}`);
    this.byName.set(decl.name, decl);
    this.decls.push(decl);
  }

  build(): void {
    for (const file of this.files.values()) {
      for (const [name, node] of file.defs) this.declare(file, name, node);
    }
  }

  /** Declares `node` under `name`. */
  declare(file: SchemaFile, name: string, node: Json): void {
    const text = description(node);
    if (node === true || (isNode(node) && isAnnotationOnly(node))) {
      this.add({ kind: "alias", name, description: text, type: { kind: "any" } });
      return;
    }
    if (!isNode(node)) fail(`${file.relPath} ${name}: unsupported schema`);
    const enumValues = this.enumValues(file, node);
    if (enumValues !== undefined) {
      this.add({ kind: "enum", name, description: text, values: enumValues });
      return;
    }
    if (Array.isArray(node.oneOf)) {
      this.declareOneOf(file, name, node, text);
      return;
    }
    if (this.isStruct(file, node)) {
      // Declared before its inline types so they follow it in the output.
      const placeholder: StructDecl = { kind: "struct", name, description: text, fields: [], tag: undefined };
      this.add(placeholder);
      const { fields, tag } = this.structFields(file, name, node);
      const decl: StructDecl = { ...placeholder, fields, tag };
      this.byName.set(name, decl);
      this.decls[this.decls.indexOf(placeholder)] = decl;
      return;
    }
    if (Array.isArray(node.anyOf) && !this.isNullable(node.anyOf)) {
      this.add({ kind: "untagged", name, description: text, variants: node.anyOf.map((member, index) => this.typeOf(file, `${name}${index + 1}`, member)) });
      return;
    }
    this.add({ kind: "alias", name, description: text, type: this.typeOf(file, name, node, true) });
  }

  /** The values of an enum schema: `enum`, or the `anyOf` of an `enum` and an open string (`{ type: string }` or an extension name). */
  enumValues(file: SchemaFile, node: Node): string[] | undefined {
    if (Array.isArray(node.enum)) return node.enum.map((value) => (typeof value === "string" ? value : fail(`${file.relPath}: non-string enum value`)));
    if (!Array.isArray(node.anyOf)) return undefined;
    const enums = node.anyOf.filter((member) => isNode(member) && Array.isArray(member.enum));
    if (enums.length !== 1) return undefined;
    const rest = node.anyOf.filter((member) => !enums.includes(member));
    const openString = (member: Json): boolean => {
      if (!isNode(member)) return false;
      if (member.type === "string") return true;
      if (typeof member.$ref === "string") {
        const target = this.resolve(file, member.$ref).node;
        return isNode(target) && target.type === "string";
      }
      return false;
    };
    if (!rest.every(openString)) return undefined;
    return ((enums[0] as Node).enum as Json[]).map(String);
  }

  isNullable(members: Json[]): boolean {
    return members.length === 2 && members.some((member) => isNode(member) && member.type === "null" && Object.keys(member).length === 1);
  }

  /** True for an object schema with properties, or an `allOf` of such schemas. */
  isStruct(file: SchemaFile, node: Node): boolean {
    if (Array.isArray(node.allOf)) return true;
    if (node.type !== "object" && node.properties === undefined) return false;
    return isNode(node.properties) && Object.keys(node.properties).length > 0;
  }

  /** The fields of a struct schema, with `allOf` members merged in order and the `const` property taken out as its tag. */
  structFields(file: SchemaFile, name: string, node: Node): { fields: Field[]; tag: StructDecl["tag"] } {
    const properties = new Map<string, { file: SchemaFile; schema: Json }>();
    const required = new Set<string>();
    const collect = (from: SchemaFile, schema: Json): void => {
      if (!isNode(schema)) fail(`${from.relPath} ${name}: unsupported allOf member`);
      if (typeof schema.$ref === "string") {
        const target = this.resolve(from, schema.$ref);
        collect(target.file, target.node);
        return;
      }
      if (Array.isArray(schema.allOf)) for (const member of schema.allOf) collect(from, member);
      if (isNode(schema.properties)) for (const [property, value] of Object.entries(schema.properties)) properties.set(property, { file: from, schema: value });
      if (Array.isArray(schema.required)) for (const property of schema.required) required.add(String(property));
    };
    collect(file, node);
    let tag: StructDecl["tag"];
    const fields: Field[] = [];
    for (const [property, { file: owner, schema }] of properties) {
      if (isNode(schema) && schema.const !== undefined) {
        if (typeof schema.const !== "string") fail(`${owner.relPath} ${name}.${property}: a const must be a string`);
        if (tag !== undefined) fail(`${owner.relPath} ${name}: two const properties`);
        tag = { field: property, value: schema.const };
        continue;
      }
      fields.push({ json: property, type: this.typeOf(owner, `${name}${pascalCase(property)}`, schema), required: required.has(property), description: description(schema) });
    }
    return { fields, tag };
  }

  declareOneOf(file: SchemaFile, name: string, node: Node, text: string | undefined): void {
    const members = (node.oneOf as Json[]).map((member, index) => {
      if (!isNode(member)) fail(`${file.relPath} ${name}: unsupported oneOf member`);
      if (typeof member.$ref === "string") {
        const target = this.resolve(file, member.$ref);
        return { file: target.file, node: target.node, ref: target.name };
      }
      return { file, node: member, ref: undefined as string | undefined, index };
    });
    // The discriminator: the property that is a const in the most members.
    const counts = new Map<string, number>();
    for (const member of members) {
      if (!isNode(member.node) || !isNode(member.node.properties)) continue;
      for (const [property, schema] of Object.entries(member.node.properties)) if (isNode(schema) && typeof schema.const === "string") counts.set(property, (counts.get(property) ?? 0) + 1);
    }
    const discriminator = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (discriminator === undefined) {
      this.add({ kind: "untagged", name, description: text, variants: members.map((member, index) => (member.ref !== undefined ? { kind: "ref" as const, name: member.ref } : this.typeOf(file, `${name}${index + 1}`, member.node))) });
      return;
    }
    const variants: Array<{ value: string; struct: string }> = [];
    const union: UnionDecl = { kind: "union", name, description: text, discriminator, variants };
    this.add(union);
    for (const member of members) {
      const constant = isNode(member.node) && isNode(member.node.properties) && isNode(member.node.properties[discriminator]) ? (member.node.properties[discriminator] as Node).const : undefined;
      if (typeof constant !== "string") continue; // an extension form: the catch-all holds it
      let struct = member.ref;
      if (struct === undefined) {
        struct = `${name}${pascalCase(constant)}`;
        this.declare(member.file, struct, member.node);
      }
      variants.push({ value: constant, struct });
    }
  }

  /** The type of a schema used inside another, declaring inline objects, enums and unions under `inlineName`. */
  typeOf(file: SchemaFile, inlineName: string, node: Json, topLevel = false): TypeRef {
    if (node === true) return { kind: "any" };
    if (!isNode(node)) fail(`${file.relPath} ${inlineName}: unsupported schema`);
    if (isAnnotationOnly(node)) return { kind: "any" };
    if (typeof node.$ref === "string") return { kind: "ref", name: this.resolve(file, node.$ref).name };
    if (!topLevel && (this.enumValues(file, node) !== undefined || Array.isArray(node.oneOf) || this.isStruct(file, node))) {
      this.declare(file, inlineName, node);
      return { kind: "ref", name: inlineName };
    }
    if (Array.isArray(node.anyOf)) {
      if (this.isNullable(node.anyOf)) {
        const inner = node.anyOf.find((member) => !(isNode(member) && member.type === "null"))!;
        return { kind: "nullable", inner: this.typeOf(file, inlineName, inner) };
      }
      if (node.anyOf.every((member) => isNode(member) && Object.keys(member).every((key) => key === "required"))) {
        // "At least one of": no type of its own.
        const rest = { ...node };
        delete rest.anyOf;
        return this.typeOf(file, inlineName, rest, topLevel);
      }
      this.declare(file, inlineName, node);
      return { kind: "ref", name: inlineName };
    }
    for (const keyword of Object.keys(node)) {
      if (!ANNOTATIONS.has(keyword) && !CONSTRAINTS.has(keyword) && !["type", "items", "prefixItems", "additionalProperties", "properties", "required"].includes(keyword)) {
        fail(`${file.relPath} ${inlineName}: keyword ${keyword} is not supported here`);
      }
    }
    const types = Array.isArray(node.type) ? node.type.map(String) : typeof node.type === "string" ? [node.type] : [];
    const nonNull = types.filter((type) => type !== "null");
    if (types.includes("null") && nonNull.length > 0) {
      return { kind: "nullable", inner: this.typeOf(file, inlineName, { ...node, type: nonNull.length === 1 ? nonNull[0]! : nonNull }) };
    }
    if (nonNull.length > 1) return { kind: "any" };
    switch (types[0]) {
      case "null":
        return { kind: "null" };
      case "string":
        return { kind: "string" };
      case "integer":
        return { kind: "integer" };
      case "number":
        return { kind: "number" };
      case "boolean":
        return { kind: "boolean" };
      case "array":
        if (Array.isArray(node.prefixItems)) return { kind: "tuple", items: node.prefixItems.map((item, index) => this.typeOf(file, `${inlineName}${index + 1}`, item)) };
        return { kind: "array", items: node.items === undefined ? { kind: "any" } : this.typeOf(file, `${inlineName}Item`, node.items) };
      case "object":
      case undefined: {
        if (isNode(node.properties) && Object.keys(node.properties).length > 0) fail(`${file.relPath} ${inlineName}: unexpected object with properties`);
        const additional = node.additionalProperties;
        return { kind: "map", values: additional === undefined || additional === true ? { kind: "any" } : this.typeOf(file, `${inlineName}Value`, additional) };
      }
      default:
        fail(`${file.relPath} ${inlineName}: unsupported type ${types[0]}`);
    }
  }
}

function readMethods(methodsFile: string, byName: ReadonlyMap<string, Decl>): { methods: MethodModel[]; ariVersion: string } {
  const table = JSON.parse(fs.readFileSync(methodsFile, "utf8")) as { ariVersion: string; methods: Array<{ [key: string]: Json }> };
  const refName = (value: Json | undefined, where: string): string => {
    if (!isNode(value) || typeof value.$ref !== "string") fail(`methods.json ${where}: expected a $ref`);
    const name = /#\/\$defs\/([A-Za-z0-9_]+)$/.exec(value.$ref)?.[1];
    if (name === undefined || !byName.has(name)) fail(`methods.json ${where}: ${value.$ref} names no definition`);
    return name;
  };
  const methods = table.methods.map((entry): MethodModel => {
    const name = String(entry.name);
    const stream = isNode(entry.stream) ? { notification: String(entry.stream.notification), item: refName(entry.stream.item, `${name}.stream.item`) } : undefined;
    const version = entry.version as { major: number; minor: number };
    return {
      name,
      direction: entry.direction as MethodModel["direction"],
      kind: entry.kind as MethodModel["kind"],
      params: refName(entry.params, `${name}.params`),
      result: entry.kind === "request" ? refName(entry.result, `${name}.result`) : undefined,
      version: { major: version.major, minor: version.minor },
      stream,
      optional: entry.optional === true,
      description: typeof entry.notes === "string" ? entry.notes : undefined,
    };
  });
  return { methods, ariVersion: table.ariVersion };
}

/** Reads json-schema/ and spec/v1/methods.json under `root`. */
export function loadWireModel(root: string): WireModel {
  const builder = new Builder(path.join(root, "json-schema"));
  builder.build();
  const { methods, ariVersion } = readMethods(path.join(root, "spec", "v1", "methods.json"), builder.byName);
  return { decls: builder.decls, byName: builder.byName, methods, ariVersion, sources: ["json-schema/*.schema.json", "spec/v1/methods.json"] };
}

/** Every ref a type mentions without going through a list, tuple or map. */
export function directRefs(type: TypeRef): string[] {
  switch (type.kind) {
    case "ref":
      return [type.name];
    case "nullable":
      return directRefs(type.inner);
    default:
      return [];
  }
}

/**
 * The declarations that can contain themselves without a list or map in
 * between: Rust boxes and Go points at such a field, or the type would be
 * infinitely large.
 */
export function recursiveEdges(model: WireModel): Set<string> {
  const edges = new Map<string, string[]>();
  for (const decl of model.decls) {
    const targets: string[] = [];
    if (decl.kind === "struct") for (const field of decl.fields) targets.push(...directRefs(field.type));
    else if (decl.kind === "union") targets.push(...decl.variants.map((variant) => variant.struct));
    else if (decl.kind === "untagged") for (const variant of decl.variants) targets.push(...directRefs(variant));
    else if (decl.kind === "alias") targets.push(...directRefs(decl.type));
    edges.set(decl.name, targets);
  }
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const next = stack.pop()!;
      for (const target of edges.get(next) ?? []) {
        if (target === to) return true;
        if (!seen.has(target)) {
          seen.add(target);
          stack.push(target);
        }
      }
    }
    return false;
  };
  const recursive = new Set<string>();
  for (const [from, targets] of edges) for (const target of targets) if (reaches(target, from)) recursive.add(`${from}->${target}`);
  return recursive;
}

/** The methods a host calls on the driver that answer, in methods.json order. */
export function hostCalls(model: WireModel): MethodModel[] {
  return model.methods.filter((method) => method.kind === "request" && method.direction !== "driver_to_host" && !method.name.startsWith("stream/") && method.name !== "initialize");
}

/** The requests the driver sends the host, in methods.json order. */
export function driverCalls(model: WireModel): MethodModel[] {
  return model.methods.filter((method) => method.kind === "request" && method.direction === "driver_to_host");
}

/** The field of a stream notification's params that carries the item (`event` for `ari/event`). */
export function streamItemField(model: WireModel, notification: string): string {
  const method = model.methods.find((candidate) => candidate.name === notification) ?? fail(`no notification ${notification}`);
  const params = model.byName.get(method.params);
  if (params?.kind !== "struct") fail(`${notification}: params are not an object`);
  const fields = params.fields.filter((field) => field.json !== "streamId");
  if (fields.length !== 1) fail(`${notification}: expected one item field besides streamId`);
  return fields[0]!.json;
}

/** `type`, with refs to aliases replaced by what they alias, to the first non-alias. */
export function resolveAliases(model: WireModel, type: TypeRef): TypeRef {
  let current = type;
  for (let depth = 0; current.kind === "ref" && depth < 32; depth += 1) {
    const decl = model.byName.get(current.name);
    if (decl?.kind !== "alias") return current;
    current = decl.type;
  }
  return current;
}
