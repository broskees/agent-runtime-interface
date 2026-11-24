// Prints clients/python/src/ari_client/_generated.py: a dataclass with
// `from_json` and `to_json` for every wire object, an open string enum for
// every enum, a decoder for every union and alias, the method version table,
// one async `Client` method per call a host makes, and the `Host` base class
// with one method per call a driver makes.

import { driverCalls, hostCalls, resolveAliases, streamItemField } from "./model.ts";
import type { Decl, EnumDecl, Field, MethodModel, StructDecl, TypeRef, UnionDecl, UntaggedDecl, WireModel } from "./model.ts";
import { methodFunction, snakeCase } from "./rust.ts";

const KEYWORDS = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case type".split(" "),
);

function attribute(json: string): string {
  const snake = snakeCase(json);
  return KEYWORDS.has(snake) || snake === "to_json" || snake === "from_json" ? `${snake}_` : snake;
}

function docstring(text: string | undefined, indent: string): string {
  if (text === undefined) return "";
  const body = text.replaceAll("\\", "\\\\").replaceAll('"""', '\\"\\"\\"');
  return `${indent}"""${body.split("\n").join(`\n${indent}`)}"""\n`;
}

function annotation(type: TypeRef): string {
  switch (type.kind) {
    case "any":
      return "Any";
    case "null":
      return "None";
    case "string":
      return "str";
    case "integer":
      return "int";
    case "number":
      return "float";
    case "boolean":
      return "bool";
    case "ref":
      return type.name;
    case "array":
      return `list[${annotation(type.items)}]`;
    case "tuple":
      return `tuple[${type.items.map(annotation).join(", ")}]`;
    case "map":
      return `dict[str, ${annotation(type.values)}]`;
    case "nullable":
      return `${annotation(type.inner)} | None`;
  }
}

/** The name of the function that decodes the named type. */
function decoderOf(model: WireModel, name: string): string {
  const decl = model.byName.get(name);
  if (decl === undefined) throw new Error(`no declaration ${name}`);
  return decl.kind === "struct" || decl.kind === "enum" ? `${name}.from_json` : `decode_${snakeCase(name)}`;
}

function decoder(model: WireModel, type: TypeRef): string {
  switch (type.kind) {
    case "any":
      return "decode_any";
    case "null":
      return "decode_null";
    case "string":
      return "decode_str";
    case "integer":
      return "decode_int";
    case "number":
      return "decode_float";
    case "boolean":
      return "decode_bool";
    case "ref":
      return decoderOf(model, type.name);
    case "array":
      return `list_of(${decoder(model, type.items)})`;
    case "tuple":
      return `tuple_of(${type.items.map((item) => decoder(model, item)).join(", ")})`;
    case "map":
      return `map_of(${decoder(model, type.values)})`;
    case "nullable":
      return `nullable(${decoder(model, type.inner)})`;
  }
}

/** How a field may be missing: required; optional (None); optional and nullable or any (UNSET when absent). */
function fieldShape(model: WireModel, field: Field): "required" | "optional" | "unset" {
  if (field.required) return "required";
  const shape = resolveAliases(model, field.type);
  return shape.kind === "nullable" || shape.kind === "any" || shape.kind === "null" ? "unset" : "optional";
}

function printStruct(model: WireModel, decl: StructDecl): string {
  const attributes = new Set<string>();
  const lines: string[] = [];
  const decodes: string[] = [];
  const encodes: string[] = [];
  for (const field of decl.fields) {
    const name = attribute(field.json);
    if (attributes.has(name)) throw new Error(`${decl.name}: two fields map to ${name}`);
    attributes.add(name);
    const shape = fieldShape(model, field);
    const type = annotation(field.type);
    const key = JSON.stringify(field.json);
    const decode = decoder(model, field.type);
    if (shape === "required") {
      lines.push(`    ${name}: ${type}`);
      decodes.push(`            ${name}=required(data, ${key}, ${decode}),`);
      encodes.push(`        out[${key}] = encode(self.${name})`);
    } else if (shape === "optional") {
      lines.push(`    ${name}: ${type} | None = None`);
      decodes.push(`            ${name}=optional(data, ${key}, ${decode}),`);
      encodes.push(`        if self.${name} is not None:\n            out[${key}] = encode(self.${name})`);
    } else {
      lines.push(`    ${name}: ${type} | Unset = UNSET`);
      decodes.push(`            ${name}=present(data, ${key}, ${decode}),`);
      encodes.push(`        if not isinstance(self.${name}, Unset):\n            out[${key}] = encode(self.${name})`);
    }
    if (field.description !== undefined) lines.push(docstring(field.description, "    ").trimEnd());
  }
  const tag = decl.tag === undefined ? "" : `    TAG: ClassVar[tuple[str, str]] = (${JSON.stringify(decl.tag.field)}, ${JSON.stringify(decl.tag.value)})\n`;
  const start = decl.tag === undefined ? "{}" : `{${JSON.stringify(decl.tag.field)}: ${JSON.stringify(decl.tag.value)}}`;
  const tagDoc = decl.tag === undefined ? undefined : `On the wire it carries \`"${decl.tag.field}": "${decl.tag.value}"\`.`;
  const doc = [decl.description, tagDoc].filter((part) => part !== undefined).join("\n\n");
  return `@dataclass(kw_only=True)
class ${decl.name}:
${docstring(doc === "" ? undefined : doc, "    ")}${tag}${lines.length === 0 ? "" : `${lines.join("\n")}\n`}
    @classmethod
    def from_json(cls, data: Any) -> ${decl.name}:
        data = require_object(data, ${JSON.stringify(decl.name)})
        return cls(
${decodes.join("\n")}
        )

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = ${start}
${encodes.length === 0 ? "" : `${encodes.join("\n")}\n`}        return out`;
}

function constantName(value: string): string {
  const name = snakeCase(value.replace(/^x:/, "x ")).toUpperCase();
  if (name === "") throw new Error(`enum value ${JSON.stringify(value)} has no usable name`);
  return /^[0-9]/.test(name) ? `V_${name}` : name;
}

function printEnum(decl: EnumDecl): string {
  const names = decl.values.map((value) => ({ value, name: constantName(value) }));
  if (new Set(names.map((entry) => entry.name)).size !== names.length) throw new Error(`${decl.name}: two values map to one name`);
  const doc = `${decl.description === undefined ? "" : `${decl.description}\n\n`}Open: a value this client does not know is kept as a member that is not recognized.`;
  return `class ${decl.name}(OpenEnum):\n${docstring(doc, "    ")}${names.map((entry) => `    ${entry.name} = ${JSON.stringify(entry.value)}`).join("\n")}`;
}

function printUnion(model: WireModel, decl: UnionDecl): string {
  const unrecognized = `Unrecognized${decl.name}`;
  if (model.byName.has(unrecognized)) throw new Error(`${unrecognized} collides with a definition`);
  const members = [...decl.variants.map((variant) => variant.struct), unrecognized];
  const table = decl.variants.map((variant) => `        ${JSON.stringify(variant.value)}: ${variant.struct},`);
  const doc = `${decl.description === undefined ? "" : `${decl.description}\n\n`}Tagged by \`${decl.discriminator}\`. A value whose \`${decl.discriminator}\` this client does not know (an \`x:\` extension, or a variant a newer ARI added) decodes as \`${unrecognized}\` with its raw JSON.`;
  return `${decl.name}: TypeAlias = ${JSON.stringify(members.join(" | "))}
${docstring(doc, "")}

@dataclass
class ${unrecognized}:
    """A \`${decl.name}\` this client does not know, kept whole."""

    raw: dict[str, Any]

    @property
    def tag(self) -> Any:
        """The \`${decl.discriminator}\` on the wire."""
        return self.raw.get(${JSON.stringify(decl.discriminator)})

    def to_json(self) -> dict[str, Any]:
        return self.raw


def decode_${snakeCase(decl.name)}(data: Any) -> ${decl.name}:
    data = require_object(data, ${JSON.stringify(decl.name)})
    variant = {
${table.join("\n")}
    }.get(data.get(${JSON.stringify(decl.discriminator)}))
    if variant is None:
        return ${unrecognized}(raw=data)
    return variant.from_json(data)`;
}

function printUntagged(model: WireModel, decl: UntaggedDecl): string {
  return `${decl.name}: TypeAlias = ${JSON.stringify(decl.variants.map(annotation).join(" | "))}
${docstring(decl.description, "")}

def decode_${snakeCase(decl.name)}(data: Any) -> ${decl.name}:
    return first_of(${JSON.stringify(decl.name)}, data, ${decl.variants.map((variant) => decoder(model, variant)).join(", ")})`;
}

function printDecl(model: WireModel, decl: Decl): string {
  switch (decl.kind) {
    case "struct":
      return printStruct(model, decl);
    case "enum":
      return printEnum(decl);
    case "union":
      return printUnion(model, decl);
    case "untagged":
      return printUntagged(model, decl);
    case "alias":
      return `${decl.name}: TypeAlias = ${JSON.stringify(annotation(decl.type))}
${docstring(decl.description, "")}

def decode_${snakeCase(decl.name)}(data: Any) -> ${decl.name}:
    return ${decoder(model, decl.type)}(data)`;
  }
}

function methodDoc(method: MethodModel): string {
  return docstring(`\`${method.name}\`${method.description === undefined ? "" : `: ${method.description}`}`, "        ");
}

function printClientMethod(model: WireModel, method: MethodModel): string {
  const name = methodFunction(method.name);
  if (method.stream !== undefined) {
    const item = streamItemField(model, method.stream.notification);
    return `    async def ${name}(self, params: ${method.params}) -> Subscription[${method.stream.item}]:
${methodDoc(method)}        return await self._subscribe(${JSON.stringify(method.name)}, params, ${JSON.stringify(item)}, ${decoderOf(model, method.stream.item)})`;
  }
  return `    async def ${name}(self, params: ${method.params}) -> ${method.result}:
${methodDoc(method)}        return ${decoderOf(model, method.result!)}(await self._call(${JSON.stringify(method.name)}, params))`;
}

function printHostMethod(method: MethodModel): string {
  return `    async def ${methodFunction(method.name, true)}(self, params: ${method.params}) -> ${method.result}:
${methodDoc(method)}        raise AriCallError(unsupported(${JSON.stringify(method.name)}, "this host does not serve it"))`;
}

export function generatePython(model: WireModel): string {
  const versions = model.methods.map((method) => `    ${JSON.stringify(method.name)}: (${method.version.major}, ${method.version.minor}),`);
  const hostMethods = driverCalls(model);
  const dispatch = hostMethods.map((method) => `    ${JSON.stringify(method.name)}: (${JSON.stringify(methodFunction(method.name, true))}, ${decoderOf(model, method.params)}),`);
  return `# Generated by clients/codegen/python.ts from ${model.sources.join(" and ")}. Do not edit.
# Change the schema and run \`pnpm run codegen:clients\` instead.
# ruff: noqa

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable, ClassVar, TypeAlias

from ._codec import (
    UNSET,
    AriCallError,
    OpenEnum,
    Unset,
    decode_any,
    decode_bool,
    decode_float,
    decode_int,
    decode_null,
    decode_str,
    encode,
    first_of,
    list_of,
    map_of,
    nullable,
    optional,
    present,
    require_object,
    required,
    tuple_of,
    unsupported,
)
from ._subscription import Subscription

ARI_VERSION = ${JSON.stringify(model.ariVersion)}
"""The ARI contract version these types follow."""

METHOD_VERSIONS: dict[str, tuple[int, int]] = {
${versions.join("\n")}
}
"""Every wire method with its (major, minor) version, from methods.json."""


${model.decls.map((decl) => printDecl(model, decl)).join("\n\n\n")}


class GeneratedCalls:
    """One method per call a host makes on the driver. \`Client\` provides \`_call\` and \`_subscribe\`."""

    _call: Callable[[str, Any], Awaitable[Any]]
    _subscribe: Callable[..., Awaitable[Any]]

${hostCalls(model)
  .map((method) => printClientMethod(model, method))
  .join("\n\n")}


class Host:
    """The host's side of the wire: one method per request a driver sends (\`host/*\`). Each refuses
    with \`unsupported\` unless a subclass serves it. \`MemoryHost\` serves the few a local host needs."""

${hostMethods.map(printHostMethod).join("\n\n")}


HOST_METHODS: dict[str, tuple[str, Callable[[Any], Any]]] = {
${dispatch.join("\n")}
}
"""Each request a driver sends its host: the \`Host\` method that answers it and its params decoder."""
`;
}
