// Prints clients/rust/src/generated.rs: serde types for every wire
// definition, the method version table, one `Client` method per call a host
// makes, and the `Host` trait with one method per call a driver makes.

import { driverCalls, hostCalls, pascalCase, resolveAliases, streamItemField } from "./model.ts";
import type { Decl, EnumDecl, Field, MethodModel, StructDecl, TypeRef, UnionDecl, UntaggedDecl, WireModel } from "./model.ts";

const KEYWORDS = new Set(
  "as async await break const continue crate dyn else enum extern false fn for gen if impl in let loop match mod move mut pub ref return self Self static struct super trait true try type unsafe use where while abstract become box do final macro override priv typeof unsized virtual yield".split(" "),
);
/** Keywords that cannot be raw identifiers. */
const NOT_RAW = new Set(["crate", "self", "Self", "super"]);

export function snakeCase(name: string): string {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return /^[0-9]/.test(snake) ? `_${snake}` : snake;
}

function fieldName(json: string): string {
  const snake = snakeCase(json);
  if (NOT_RAW.has(snake)) return `${snake}_`;
  return KEYWORDS.has(snake) ? `r#${snake}` : snake;
}

function doc(text: string | undefined, indent: string): string {
  if (text === undefined) return "";
  // Brackets would read as intra-doc links.
  return text
    .split("\n")
    .map((line) => `${indent}/// ${line.replace(/([[\]])/g, "\\$1")}`.trimEnd())
    .join("\n")
    .concat("\n");
}

function typeName(type: TypeRef): string {
  switch (type.kind) {
    case "any":
      return "serde_json::Value";
    case "null":
      return "()";
    case "string":
      return "String";
    case "integer":
      return "i64";
    case "number":
      return "f64";
    case "boolean":
      return "bool";
    case "ref":
      return type.name;
    case "array":
      return `Vec<${typeName(type.items)}>`;
    case "tuple":
      return `(${type.items.map(typeName).join(", ")})`;
    case "map":
      return `BTreeMap<String, ${typeName(type.values)}>`;
    case "nullable":
      return `Option<${typeName(type.inner)}>`;
  }
}

function printField(model: WireModel, field: Field): string {
  const name = fieldName(field.json);
  const attributes: string[] = [];
  if (snakeCase(field.json) !== field.json || name.startsWith("r#")) attributes.push(`rename = ${JSON.stringify(field.json)}`);
  let type = typeName(field.type);
  if (!field.required) {
    attributes.push(`default`, `skip_serializing_if = "Option::is_none"`);
    const shape = resolveAliases(model, field.type);
    if (shape.kind === "nullable" || shape.kind === "null") {
      // Patch semantics: absent (outer None), null (Some(None)) and a value are three different things.
      attributes.push(`with = "crate::wire::double_option"`);
      type = `Option<${type}>`;
    } else if (shape.kind === "any") {
      // An absent field is None; a JSON null is Some(Value::Null).
      attributes.push(`deserialize_with = "crate::wire::present"`);
      type = `Option<${type}>`;
    } else {
      type = `Option<${type}>`;
    }
  }
  const attribute = attributes.length === 0 ? "" : `    #[serde(${attributes.join(", ")})]\n`;
  return `${doc(field.description, "    ")}${attribute}    pub ${name}: ${type},`;
}

const DEFAULTABLE = new Map<string, boolean>();

/** True when every required field of the struct `name` has a type with an obvious empty value. */
function defaultable(model: WireModel, name: string): boolean {
  const known = DEFAULTABLE.get(name);
  if (known !== undefined) return known;
  DEFAULTABLE.set(name, false); // a cycle is not defaultable
  const decl = model.byName.get(name);
  const typeDefaultable = (type: TypeRef): boolean => {
    switch (type.kind) {
      case "ref": {
        const target = model.byName.get(type.name);
        if (target?.kind === "alias") return typeDefaultable(target.type);
        return target?.kind === "struct" && defaultable(model, type.name);
      }
      case "tuple":
        return type.items.every(typeDefaultable);
      default:
        return true;
    }
  };
  const result = decl?.kind === "struct" && decl.fields.every((field) => !field.required || typeDefaultable(field.type));
  DEFAULTABLE.set(name, result);
  return result;
}

function printStruct(model: WireModel, decl: StructDecl): string {
  const names = new Set<string>();
  for (const field of decl.fields) {
    const name = fieldName(field.json);
    if (names.has(name)) throw new Error(`${decl.name}: two fields map to ${name}`);
    names.add(name);
  }
  const tag = decl.tag === undefined ? "" : `#[serde(tag = ${JSON.stringify(decl.tag.field)}, rename = ${JSON.stringify(decl.tag.value)})]\n`;
  const tagDoc = decl.tag === undefined ? "" : `///\n/// On the wire it carries \`"${decl.tag.field}": "${decl.tag.value}"\`.\n`;
  const body = decl.fields.length === 0 ? " {}" : ` {\n${decl.fields.map((field) => printField(model, field)).join("\n")}\n}`;
  const derives = defaultable(model, decl.name) ? "Debug, Clone, Default, PartialEq, Serialize, Deserialize" : "Debug, Clone, PartialEq, Serialize, Deserialize";
  return `${doc(decl.description, "")}${tagDoc}#[derive(${derives})]\n${tag}pub struct ${decl.name}${body}`;
}

function variantName(value: string, owner: string): string {
  const name = pascalCase(value.replace(/^x:/, "X "));
  if (name === "" || name === "Unrecognized") throw new Error(`${owner}: value ${JSON.stringify(value)} has no usable variant name`);
  return /^[0-9]/.test(name) ? `V${name}` : name;
}

function printEnum(decl: EnumDecl): string {
  const variants = decl.values.map((value) => ({ value, name: variantName(value, decl.name) }));
  if (new Set(variants.map((variant) => variant.name)).size !== variants.length) throw new Error(`${decl.name}: two values map to one variant name`);
  const lines = variants.map((variant) => `    ${variant.name} = ${JSON.stringify(variant.value)},`);
  const docs = doc(`${decl.description === undefined ? "" : `${decl.description}\n\n`}Open: a value this client does not know is kept as \`Unrecognized\`.`, "    ");
  return `crate::open_enum! {\n${docs}    ${decl.name} {\n${lines.map((line) => `    ${line}`).join("\n")}\n    }\n}`;
}

function printUnion(decl: UnionDecl): string {
  const variants = decl.variants.map((variant) => ({ ...variant, name: variantName(variant.value, decl.name) }));
  const lines = variants.map((variant) => `    /// \`"${decl.discriminator}": "${variant.value}"\`\n    ${variant.name}(${variant.struct}),`);
  const serialize = variants.map((variant) => `            Self::${variant.name}(value) => value.serialize(serializer),`);
  const deserialize = variants.map(
    (variant) => `            Some(${JSON.stringify(variant.value)}) => serde_json::from_value(value).map(Self::${variant.name}).map_err(serde::de::Error::custom),`,
  );
  const tags = variants.map((variant) => `            Self::${variant.name}(_) => Some(${JSON.stringify(variant.value)}),`);
  return `${doc(decl.description, "")}///
/// Tagged by \`${decl.discriminator}\`. A value whose \`${decl.discriminator}\` this client does not know (an \`x:\`
/// extension, or a variant a newer ARI added) is kept whole as \`Unrecognized\`.
#[derive(Debug, Clone, PartialEq)]
pub enum ${decl.name} {
${lines.join("\n")}
    /// A variant this client does not know, with its raw JSON.
    Unrecognized(serde_json::Value),
}

impl ${decl.name} {
    /// The \`${decl.discriminator}\` on the wire.
    pub fn tag(&self) -> Option<&str> {
        match self {
${tags.join("\n")}
            Self::Unrecognized(value) => value.get(${JSON.stringify(decl.discriminator)}).and_then(serde_json::Value::as_str),
        }
    }
}

impl Serialize for ${decl.name} {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
${serialize.join("\n")}
            Self::Unrecognized(value) => value.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for ${decl.name} {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        let tag = value.get(${JSON.stringify(decl.discriminator)}).and_then(serde_json::Value::as_str).map(str::to_owned);
        match tag.as_deref() {
${deserialize.join("\n")}
            _ => Ok(Self::Unrecognized(value)),
        }
    }
}`;
}

function printUntagged(decl: UntaggedDecl): string {
  const lines = decl.variants.map((variant, index) => `    ${variant.kind === "ref" ? variant.name : `V${index + 1}`}(${typeName(variant)}),`);
  return `${doc(decl.description, "")}#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]\n#[serde(untagged)]\npub enum ${decl.name} {\n${lines.join("\n")}\n}`;
}

function printDecl(model: WireModel, decl: Decl): string {
  switch (decl.kind) {
    case "struct":
      return printStruct(model, decl);
    case "enum":
      return printEnum(decl);
    case "union":
      return printUnion(decl);
    case "untagged":
      return printUntagged(decl);
    case "alias":
      return `${doc(decl.description, "")}pub type ${decl.name} = ${typeName(decl.type)};`;
  }
}

/** `session/createThread` as `session_create_thread`, `instance/auth.methods` as `instance_auth_methods`. */
export function methodFunction(method: string, dropPrefix = false): string {
  const name = dropPrefix ? method.slice(method.indexOf("/") + 1) : method;
  return snakeCase(name.replace(/[/.]/g, "_"));
}

function methodDoc(method: MethodModel): string {
  return doc(`\`${method.name}\`${method.description === undefined ? "" : `: ${method.description}`}`, "    ");
}

function printClientMethod(model: WireModel, method: MethodModel): string {
  const name = methodFunction(method.name);
  if (method.stream !== undefined) {
    const item = streamItemField(model, method.stream.notification);
    return `${methodDoc(method)}    pub async fn ${name}(&self, params: &${method.params}) -> Result<crate::Subscription<${method.stream.item}>, CallError> {
        self.subscribe(${JSON.stringify(method.name)}, params, ${JSON.stringify(method.stream.notification)}, ${JSON.stringify(item)}).await
    }`;
  }
  return `${methodDoc(method)}    pub async fn ${name}(&self, params: &${method.params}) -> Result<${method.result}, CallError> {
        self.call(${JSON.stringify(method.name)}, params).await
    }`;
}

function printHostMethod(method: MethodModel): string {
  const name = methodFunction(method.name, true);
  return `${methodDoc(method)}    fn ${name}(&self, params: ${method.params}) -> HostFuture<'_, ${method.result}> {
        let _ = params;
        Box::pin(async { Err(crate::unsupported(${JSON.stringify(method.name)}, "this host does not serve it")) })
    }`;
}

function printDispatch(method: MethodModel): string {
  const name = methodFunction(method.name, true);
  return `        ${JSON.stringify(method.name)} => to_result(host.${name}(from_params(params)?).await),`;
}

export function generateRust(model: WireModel): string {
  const versions = model.methods.map((method) => `    (${JSON.stringify(method.name)}, ${method.version.major}, ${method.version.minor}),`);
  const hostMethods = driverCalls(model);
  return `// Generated by clients/codegen/rust.ts from ${model.sources.join(" and ")}. Do not edit.
// Change the schema and run \`pnpm run codegen:clients\` instead.

#![allow(clippy::large_enum_variant, clippy::type_complexity)]

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;

use serde::{Deserialize, Serialize};

/// The ARI contract version these types follow.
pub const ARI_VERSION: &str = ${JSON.stringify(model.ariVersion)};

/// Every wire method with its \`(major, minor)\` version, from methods.json.
pub const METHOD_VERSIONS: &[(&str, u32, u32)] = &[
${versions.join("\n")}
];

${model.decls.map((decl) => printDecl(model, decl)).join("\n\n")}

impl crate::Client {
${hostCalls(model)
  .map((method) => printClientMethod(model, method))
  .join("\n\n")}
}

/// The requests a driver sends its host, from methods.json.
pub const HOST_METHODS: &[&str] = &[
${hostMethods.map((method) => `    ${JSON.stringify(method.name)},`).join("\n")}
];

/// What a host answers with: a boxed future, so \`Host\` stays object safe.
pub type HostFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, CallError>> + Send + 'a>>;

/// The host's side of the wire: one method per request a driver sends (\`host/*\`). Each defaults to
/// refusing with \`unsupported\`; implement the ones your host serves. \`MemoryHost\` serves the few
/// a local host needs.
pub trait Host: Send + Sync + 'static {
${hostMethods.map(printHostMethod).join("\n\n")}
}

fn from_params<T: serde::de::DeserializeOwned>(params: serde_json::Value) -> Result<T, CallError> {
    serde_json::from_value(params).map_err(|error| crate::validation(&error.to_string()))
}

fn to_result<T: Serialize>(answer: Result<T, CallError>) -> Result<serde_json::Value, CallError> {
    let value = answer?;
    serde_json::to_value(value).map_err(|error| crate::protocol("unserializable_result", &error.to_string()))
}

/// Calls the \`Host\` method a driver's request names.
pub(crate) async fn dispatch_host(host: &dyn Host, method: &str, params: serde_json::Value) -> Result<serde_json::Value, CallError> {
    match method {
${hostMethods.map(printDispatch).join("\n")}
        _ => Err(crate::unsupported(method, "no such host method")),
    }
}
`;
}
