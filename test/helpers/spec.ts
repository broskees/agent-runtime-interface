// Shared helpers for tests that read spec/v1 directly.

import * as fs from "node:fs";
import * as path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const SPEC_DIR = path.join(REPO_ROOT, "spec", "v1");

export type JsonObject = { [key: string]: unknown };

export interface SpecFileInfo {
  /** Path relative to spec/v1, with forward slashes. */
  readonly relPath: string;
  readonly document: JsonObject;
}

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/** Every `*.schema.json` file under spec/v1. */
export function specSchemaFiles(): SpecFileInfo[] {
  return walk(SPEC_DIR)
    .filter((full) => full.endsWith(".schema.json"))
    .sort()
    .map((full) => ({
      relPath: path.relative(SPEC_DIR, full).split(path.sep).join("/"),
      document: JSON.parse(fs.readFileSync(full, "utf8")) as JsonObject,
    }));
}

export function readMethodTable(): JsonObject {
  return JSON.parse(fs.readFileSync(path.join(SPEC_DIR, "methods.json"), "utf8")) as JsonObject;
}

/**
 * An Ajv instance for draft 2020-12 with every spec/v1 schema file added.
 * Strict mode stays on, so unknown keywords fail. Two of Ajv's own lints are
 * turned off because they flag valid JSON Schema the spec uses on purpose:
 * `"type": [..]` arrays (`allowUnionTypes`) and `anyOf` branches that only
 * list `required` fields (`strictRequired`).
 */
export function createSpecAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true, strictRequired: false });
  for (const file of specSchemaFiles()) ajv.addSchema(file.document);
  return ajv;
}

/** The absolute id of a definition, for example `defId("events.schema.json", "AriEvent")`. */
export function defId(relPath: string, name: string): string {
  return `https://ari.invalid/spec/v1/${relPath}#/$defs/${name}`;
}

/** Resolves a reference like `rpc.schema.json#/$defs/X` (relative to spec/v1) to its schema node. */
export function resolveSpecRef(ref: string, fromRelPath = ""): { relPath: string; node: unknown } {
  const [filePart = "", pointer = ""] = ref.split("#");
  const relPath = filePart === "" ? fromRelPath : path.posix.normalize(path.posix.join(path.posix.dirname(fromRelPath || "x"), filePart));
  const full = path.join(SPEC_DIR, relPath);
  if (!fs.existsSync(full)) throw new Error(`reference ${ref} names missing file ${relPath}`);
  let node: unknown = JSON.parse(fs.readFileSync(full, "utf8"));
  for (const segment of pointer.split("/").slice(1)) {
    if (typeof node !== "object" || node === null) throw new Error(`reference ${ref} does not resolve`);
    node = (node as JsonObject)[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  if (node === undefined) throw new Error(`reference ${ref} does not resolve`);
  return { relPath, node };
}
