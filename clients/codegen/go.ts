// Prints clients/go/generated.go: a struct for every wire object, a string
// type with constants for every enum, a wrapper with a typed `Value` for
// every union, the method version table, one `Client` method per call a host
// makes (a typed channel for each stream), and the `Host` interface with one
// method per call a driver makes.

import { spawnSync } from "node:child_process";
import { driverCalls, hostCalls, resolveAliases, streamItemField } from "./model.ts";
import type { Decl, EnumDecl, Field, MethodModel, StructDecl, TypeRef, UnionDecl, UntaggedDecl, WireModel } from "./model.ts";

/** Words Go spells in capitals. */
const INITIALISMS = new Map([
  ["Id", "ID"],
  ["Ids", "IDs"],
  ["Url", "URL"],
  ["Uri", "URI"],
  ["Json", "JSON"],
  ["Http", "HTTP"],
  ["Api", "API"],
]);

/** `sessionId` as `SessionID`, `x:vendor.ping` as `XVendorPing`. */
export function goName(text: string): string {
  const words = text
    .replace(/^x:/, "x ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "")
    .map((word) => word[0]!.toUpperCase() + word.slice(1));
  const name = words.map((word) => INITIALISMS.get(word) ?? word).join("");
  return /^[0-9]/.test(name) ? `V${name}` : name;
}

function comment(text: string | undefined, indent: string): string {
  if (text === undefined) return "";
  return text
    .split("\n")
    .map((line) => `${indent}// ${line}`.trimEnd())
    .join("\n")
    .concat("\n");
}

function typeName(model: WireModel, type: TypeRef): string {
  switch (type.kind) {
    case "any":
      return "any";
    case "null":
      return "Null";
    case "string":
      return "string";
    case "integer":
      return "int64";
    case "number":
      return "float64";
    case "boolean":
      return "bool";
    case "ref":
      return type.name;
    case "array":
      return `[]${typeName(model, type.items)}`;
    case "tuple": {
      const items = type.items.map((item) => typeName(model, item));
      if (new Set(items).size !== 1) throw new Error("a tuple of mixed types has no Go form here");
      return `[${items.length}]${items[0]}`;
    }
    case "map":
      return `map[string]${typeName(model, type.values)}`;
    case "nullable": {
      // Slices, maps, any and union wrappers already have a null value of their own.
      const inner = resolveAliases(model, type.inner);
      if (inner.kind === "array" || inner.kind === "map" || inner.kind === "any" || inner.kind === "nullable") return typeName(model, type.inner);
      return `*${typeName(model, type.inner)}`;
    }
  }
}

/** True when the zero value of the type is nil, so an absent field needs no pointer. */
function nilable(model: WireModel, type: TypeRef): boolean {
  const shape = resolveAliases(model, type);
  // A union wrapper's zero value holds no variant, which omitzero leaves out.
  if (shape.kind === "ref" && ["untagged", "union"].includes(model.byName.get(shape.name)?.kind ?? "")) return true;
  return shape.kind === "array" || shape.kind === "map" || shape.kind === "any" || shape.kind === "null" || shape.kind === "nullable";
}

function printField(model: WireModel, field: Field): string {
  const name = goName(field.json);
  const shape = resolveAliases(model, field.type);
  let type = typeName(model, field.type);
  let options = "";
  if (!field.required) {
    options = ",omitzero";
    if (shape.kind === "nullable" || shape.kind === "null") {
      // Patch semantics: absent, null and a value are three different things.
      type = `Nullable[${typeName(model, shape.kind === "nullable" ? shape.inner : shape)}]`;
    } else if (!nilable(model, field.type)) {
      type = `*${type}`;
    }
  }
  return `${comment(field.description, "\t")}\t${name} ${type} \`json:"${field.json}${options}"\``;
}

function printStruct(model: WireModel, decl: StructDecl, markers: ReadonlyMap<string, string[]>): string {
  const names = new Set<string>();
  for (const field of decl.fields) {
    const name = goName(field.json);
    if (names.has(name)) throw new Error(`${decl.name}: two fields map to ${name}`);
    names.add(name);
  }
  const tagDoc = decl.tag === undefined ? undefined : `On the wire it carries "${decl.tag.field}": "${decl.tag.value}"; MarshalJSON adds it.`;
  const doc = comment([decl.description, tagDoc].filter((part) => part !== undefined).join("\n\n") || undefined, "");
  const body = decl.fields.length === 0 ? "struct{}" : `struct {\n${decl.fields.map((field) => printField(model, field)).join("\n")}\n}`;
  const parts = [`${doc}type ${decl.name} ${body}`];
  if (decl.tag !== undefined) {
    parts.push(`func (v ${decl.name}) MarshalJSON() ([]byte, error) {
\ttype plain ${decl.name}
\treturn json.Marshal(struct {
\t\tTag string \`json:"${decl.tag.field}"\`
\t\tplain
\t}{${JSON.stringify(decl.tag.value)}, plain(v)})
}`);
  }
  for (const union of markers.get(decl.name) ?? []) parts.push(`func (*${decl.name}) is${union}() {}`);
  return parts.join("\n\n");
}

function printEnum(decl: EnumDecl): string {
  const constants = decl.values.map((value) => ({ value, name: `${decl.name}${goName(value)}` }));
  if (new Set(constants.map((constant) => constant.name)).size !== constants.length) throw new Error(`${decl.name}: two values map to one name`);
  const doc = comment(`${decl.description === undefined ? "" : `${decl.description}\n\n`}Open: any string is kept; Recognized reports whether this client knows it.`, "");
  return `${doc}type ${decl.name} string

const (
${constants.map((constant) => `\t${constant.name} ${decl.name} = ${JSON.stringify(constant.value)}`).join("\n")}
)

// Recognized reports whether this client knows the value.
func (v ${decl.name}) Recognized() bool {
\tswitch v {
\tcase ${constants.map((constant) => constant.name).join(", ")}:
\t\treturn true
\t}
\treturn false
}`;
}

function printUnion(decl: UnionDecl): string {
  const unrecognized = `Unrecognized${decl.name}`;
  const cases = decl.variants.map(
    (variant) => `\tcase ${JSON.stringify(variant.value)}:
\t\tvar value ${variant.struct}
\t\tif err := json.Unmarshal(data, &value); err != nil {
\t\t\treturn err
\t\t}
\t\tu.Value = &value`,
  );
  const doc = comment(
    `${decl.description === undefined ? "" : `${decl.description}\n\n`}Tagged by "${decl.discriminator}". Value is one of ${decl.variants.map((variant) => `*${variant.struct}`).join(", ")}, or *${unrecognized} for a "${decl.discriminator}" this client does not know (an x: extension, or a variant a newer ARI added), kept with its raw JSON.`,
    "",
  );
  return `${doc}type ${decl.name} struct {
\tValue ${decl.name}Variant
}

// ${decl.name}Variant is a type a ${decl.name} can hold.
type ${decl.name}Variant interface {
\tis${decl.name}()
}

// ${unrecognized} is a ${decl.name} this client does not know, kept whole.
type ${unrecognized} struct {
\tRaw json.RawMessage
}

func (*${unrecognized}) is${decl.name}() {}

// Tag is the "${decl.discriminator}" on the wire.
func (v *${unrecognized}) Tag() string {
\treturn tagOf(v.Raw, ${JSON.stringify(decl.discriminator)})
}

func (u ${decl.name}) MarshalJSON() ([]byte, error) {
\tswitch value := u.Value.(type) {
\tcase nil:
\t\treturn []byte("null"), nil
\tcase *${unrecognized}:
\t\treturn value.Raw, nil
\tdefault:
\t\treturn json.Marshal(value)
\t}
}

func (u *${decl.name}) UnmarshalJSON(data []byte) error {
\tif isNull(data) {
\t\tu.Value = nil
\t\treturn nil
\t}
\tswitch tagOf(data, ${JSON.stringify(decl.discriminator)}) {
${cases.join("\n")}
\tdefault:
\t\tu.Value = &${unrecognized}{Raw: append(json.RawMessage(nil), data...)}
\t}
\treturn nil
}`;
}

function printUntagged(model: WireModel, decl: UntaggedDecl): string {
  const variants = decl.variants.map((variant) => {
    const target = variant.kind === "ref" ? model.byName.get(variant.name) : undefined;
    if (target?.kind !== "struct") throw new Error(`${decl.name}: only struct variants have a Go form here`);
    return { name: target.name, required: target.fields.filter((field) => field.required).map((field) => field.json) };
  });
  const cases = variants.map(
    (variant) => `\tif hasFields(data, ${variant.required.map((field) => JSON.stringify(field)).join(", ")}) {
\t\tvar value ${variant.name}
\t\tif err := json.Unmarshal(data, &value); err != nil {
\t\t\treturn err
\t\t}
\t\tu.Value = &value
\t\treturn nil
\t}`,
  );
  const doc = comment(`${decl.description === undefined ? "" : `${decl.description}\n\n`}Value is one of ${variants.map((variant) => `*${variant.name}`).join(", ")}, chosen by the fields present.`, "");
  return `${doc}type ${decl.name} struct {
\tValue any
}

func (u ${decl.name}) MarshalJSON() ([]byte, error) {
\treturn json.Marshal(u.Value)
}

func (u *${decl.name}) UnmarshalJSON(data []byte) error {
${cases.join("\n")}
\treturn fmt.Errorf("${decl.name}: no variant matches %s", data)
}`;
}

function printDecl(model: WireModel, decl: Decl, markers: ReadonlyMap<string, string[]>): string {
  switch (decl.kind) {
    case "struct":
      return printStruct(model, decl, markers);
    case "enum":
      return printEnum(decl);
    case "union":
      return printUnion(decl);
    case "untagged":
      return printUntagged(model, decl);
    case "alias":
      return `${comment(decl.description, "")}type ${decl.name} = ${typeName(model, decl.type)}`;
  }
}

function methodComment(name: string, method: MethodModel): string {
  return comment(`${name} calls ${method.name}.${method.description === undefined ? "" : ` ${method.description}`}`, "");
}

function printClientMethod(model: WireModel, method: MethodModel): string {
  const name = goName(method.name.replace(/[/.]/g, " "));
  if (method.stream !== undefined) {
    const item = streamItemField(model, method.stream.notification);
    return `${methodComment(name, method)}func (c *Client) ${name}(ctx context.Context, params ${method.params}) (*Stream[${method.stream.item}], error) {
\treturn subscribe[${method.stream.item}](ctx, c, ${JSON.stringify(method.name)}, params, ${JSON.stringify(item)})
}`;
  }
  return `${methodComment(name, method)}func (c *Client) ${name}(ctx context.Context, params ${method.params}) (${method.result}, error) {
\tvar result ${method.result}
\terr := c.call(ctx, ${JSON.stringify(method.name)}, params, &result)
\treturn result, err
}`;
}

function hostMethodName(method: MethodModel): string {
  return goName(method.name.slice("host/".length).replace(/[/.]/g, " "));
}

export function generateGo(model: WireModel): string {
  const markers = new Map<string, string[]>();
  for (const decl of model.decls) {
    if (decl.kind !== "union") continue;
    for (const variant of decl.variants) markers.set(variant.struct, [...(markers.get(variant.struct) ?? []), decl.name]);
  }
  const hostMethods = driverCalls(model);
  const interfaceLines = hostMethods.map((method) => `${comment(`${hostMethodName(method)} answers ${method.name}.`, "\t")}\t${hostMethodName(method)}(ctx context.Context, params ${method.params}) (${method.result}, error)`);
  const defaults = hostMethods.map(
    (method) => `func (UnsupportedHost) ${hostMethodName(method)}(ctx context.Context, params ${method.params}) (${method.result}, error) {
\tvar zero ${method.result}
\treturn zero, Unsupported(${JSON.stringify(method.name)}, "this host does not serve it")
}`,
  );
  const dispatch = hostMethods.map(
    (method) => `\tcase ${JSON.stringify(method.name)}:
\t\tvar p ${method.params}
\t\tif err := json.Unmarshal(params, &p); err != nil {
\t\t\treturn nil, invalidParams(err)
\t\t}
\t\treturn host.${hostMethodName(method)}(ctx, p)`,
  );
  return gofmt(`// Code generated by clients/codegen/go.ts from ${model.sources.join(" and ")}. DO NOT EDIT.
// Change the schema and run \`pnpm run codegen:clients\` instead.

package ari

import (
\t"context"
\t"encoding/json"
\t"fmt"
)

// AriVersion is the ARI contract version these types follow.
const AriVersion = ${JSON.stringify(model.ariVersion)}

// WireMethodVersions holds every wire method with its major and minor version, from methods.json.
var WireMethodVersions = map[string]Version{
${model.methods.map((method) => `\t${JSON.stringify(method.name)}: {Major: ${method.version.major}, Minor: ${method.version.minor}},`).join("\n")}
}

${model.decls.map((decl) => printDecl(model, decl, markers)).join("\n\n")}

${hostCalls(model)
  .map((method) => printClientMethod(model, method))
  .join("\n\n")}

// Host is the host's side of the wire: one method per request a driver sends (host/*). Embed
// UnsupportedHost to refuse the ones a host does not serve; MemoryHost serves the few a local
// host needs.
type Host interface {
${interfaceLines.join("\n")}
}

// UnsupportedHost refuses every host request with unsupported. Embed it in a Host.
type UnsupportedHost struct{}

${defaults.join("\n\n")}

// hostMethods are the requests a driver sends its host, from methods.json.
var hostMethods = map[string]bool{
${hostMethods.map((method) => `\t${JSON.stringify(method.name)}: true,`).join("\n")}
}

// dispatchHost calls the Host method a driver's request names.
func dispatchHost(ctx context.Context, host Host, method string, params json.RawMessage) (any, error) {
\tswitch method {
${dispatch.join("\n")}
\t}
\treturn nil, Unsupported(method, "no such host method")
}
`);
}

/** \`source\` as gofmt prints it, so the generated file reads like any other Go file. */
function gofmt(source: string): string {
  const result = spawnSync(process.env["GOFMT"] ?? "gofmt", [], { input: source, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined) throw new Error(`could not run gofmt (install Go, or set GOFMT): ${result.error.message}`);
  if (result.status !== 0) throw new Error(`gofmt refused the generated Go:\n${result.stderr}`);
  return result.stdout;
}

