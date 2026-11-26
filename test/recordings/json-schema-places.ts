// Vendored JSON Schemas as a ProtocolGraph (./protocol-places.ts), for the
// kits whose native side is described by a vendored schema: ACP
// (vendor-schemas/acp/) and the Codex app-server (vendor-schemas/codex/). A
// value is a schema: its words are each string `const` and `enum` value,
// through `$ref`, `allOf`, `anyOf`, `oneOf`, `items` and `prefixItems`; its
// shapes the schemas among those with `properties` or an
// `additionalProperties` schema. A shape's fields are its `properties`, and
// its `additionalProperties` schema is its schema for every other key; it
// requires the keys its `required` lists. A schema of `true`, or one with
// neither, holds no shape: the walk stops there.
//
// `$ref` resolves through the document each schema object came from:
// `schemaDocument` reads a file and records where every object in it came
// from, so roots taken from several files (ACP's v1 and v2) resolve each in
// its own.

import * as fs from "node:fs";
import type { ProtocolGraph } from "./protocol-places.ts";

export type Schema = { readonly [keyword: string]: unknown };

const COMBINATIONS = ["allOf", "anyOf", "oneOf"] as const;

export function isSchema(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Where each schema object came from, to resolve its `$ref`: the `$ref` pointer to the schema it names. */
const owners = new WeakMap<object, (pointer: string) => Schema>();

/** Reads a schema file and records every object in it as its own, so `$ref`s in it resolve against it. Returns the document. */
export function schemaDocument(file: string): Schema {
  const document = JSON.parse(fs.readFileSync(file, "utf8")) as Schema;
  adoptSchema(document, document, file);
  return document;
}

/** Records every object in `node` (a schema `document` holds, or one built beside it) as `document`'s, for `$ref`. */
export function adoptSchema(node: unknown, document: Schema, file: string): void {
  const resolve = (pointer: string): Schema => {
    if (!pointer.startsWith("#/")) throw new Error(`${file}: cannot resolve ${pointer}`);
    let target: unknown = document;
    for (const part of pointer.slice(2).split("/")) target = isSchema(target) ? target[part.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined;
    if (!isSchema(target)) throw new Error(`${file}: cannot resolve ${pointer}`);
    return target;
  };
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null || owners.has(value)) return;
    owners.set(value, resolve);
    for (const each of Array.isArray(value) ? value : Object.values(value)) visit(each);
  };
  visit(node);
}

function resolved(node: Schema): Schema {
  const pointer = node["$ref"];
  if (typeof pointer !== "string") return node;
  const resolve = owners.get(node);
  if (resolve === undefined) throw new Error(`a schema with $ref ${pointer} that came from no document`);
  return resolve(pointer);
}

/** Every schema `node` stands for: itself, what its `$ref` names, its combinations' members and its array items, at any depth. */
function alternatives(node: unknown, seen = new Set<Schema>()): Schema[] {
  if (!isSchema(node) || seen.has(node)) return [];
  seen.add(node);
  const found: Schema[] = [node];
  if (typeof node["$ref"] === "string") found.push(...alternatives(resolved(node), seen));
  for (const combination of COMBINATIONS) if (Array.isArray(node[combination])) for (const member of node[combination] as unknown[]) found.push(...alternatives(member, seen));
  if (isSchema(node["items"])) found.push(...alternatives(node["items"], seen));
  if (Array.isArray(node["prefixItems"])) for (const item of node["prefixItems"] as unknown[]) found.push(...alternatives(item, seen));
  return found;
}

export function jsonSchemaGraph(): ProtocolGraph<Schema, unknown> {
  const fields = new Map<Schema, Map<string, unknown[]>>();
  return {
    words: (value) =>
      alternatives(value).flatMap((node) => [...(typeof node["const"] === "string" ? [node["const"]] : []), ...(Array.isArray(node["enum"]) ? (node["enum"] as unknown[]).filter((each): each is string => typeof each === "string") : [])]),
    shapes: (value) => alternatives(value).filter((node) => isSchema(node["properties"]) || isSchema(node["additionalProperties"])),
    fields: (shape) => {
      let own = fields.get(shape);
      if (own === undefined) {
        own = new Map(Object.entries(isSchema(shape["properties"]) ? shape["properties"] : {}).map(([key, property]) => [key, [property]]));
        fields.set(shape, own);
      }
      return own;
    },
    anyKey: (shape) => (isSchema(shape["additionalProperties"]) ? [shape["additionalProperties"]] : undefined),
    requires: (shape, key) => Array.isArray(shape["required"]) && (shape["required"] as unknown[]).includes(key),
  };
}
