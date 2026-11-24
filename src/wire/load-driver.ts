// Finds the driver `ari-driver` serves.
//
// - A first-party driver by name (`ari-driver pi`) is the module
//   `ari/drivers/<name>`, found by convention next to this file
//   (`../drivers/<name>/index.js`), so adding a driver needs no registry.
//   Names are lowercase letters, digits and hyphens.
// - Any other driver by module path (`ari-driver ./my-driver.js`): an argument
//   that contains a path separator, starts with `.`, or ends in a JavaScript or
//   TypeScript extension is a path, resolved against the current directory and
//   loaded as a file URL, never as a package name.
//
// From the module, the driver is: the export `--export` names; else the
// default export, if it is a driver; else the only export that is a driver;
// else the one whose `kind` is the name asked for.

import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Driver } from "../runtime.ts";

const FIRST_PARTY_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** True when `value` has the members of `Driver`. */
export function isDriver(value: unknown): value is Driver {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { [key: string]: unknown };
  return (
    typeof candidate.kind === "string" &&
    typeof candidate.ariVersion === "string" &&
    typeof candidate.metadata === "object" &&
    candidate.metadata !== null &&
    candidate.configSchema !== undefined &&
    typeof candidate.defaultConfig === "function" &&
    typeof candidate.create === "function"
  );
}

/** True when `spec` names a module file rather than a first-party driver. */
export function isModulePath(spec: string): boolean {
  return spec.includes("/") || spec.includes("\\") || spec.startsWith(".") || /\.(?:[cm]?js|[cm]?ts)$/.test(spec);
}

/** Picks the driver out of a loaded module. */
export function pickDriver(module: { readonly [name: string]: unknown }, described: string, options: { readonly name?: string; readonly exportName?: string } = {}): Driver {
  if (options.exportName !== undefined) {
    const chosen = module[options.exportName];
    if (!isDriver(chosen)) throw new Error(`${described} has no driver export named ${JSON.stringify(options.exportName)}`);
    return chosen;
  }
  if (isDriver(module.default)) return module.default;
  const drivers = Object.entries(module).filter(([, value]) => isDriver(value)) as Array<[string, Driver]>;
  if (drivers.length === 1) return drivers[0]![1];
  const byKind = options.name === undefined ? undefined : drivers.find(([, driver]) => driver.kind === options.name);
  if (byKind !== undefined) return byKind[1];
  if (drivers.length === 0) throw new Error(`${described} exports no driver (an object with kind, ariVersion, metadata, configSchema, defaultConfig and create)`);
  throw new Error(`${described} exports several drivers (${drivers.map(([name]) => name).join(", ")}); choose one with --export <name>`);
}

/** Loads the driver `spec` names: a first-party driver name or a module path. */
export async function loadDriver(spec: string, options: { readonly exportName?: string } = {}): Promise<Driver> {
  if (isModulePath(spec)) {
    const file = path.resolve(spec);
    if (!existsSync(file)) throw new Error(`No driver module at ${file}`);
    const module = (await import(pathToFileURL(file).href)) as { [name: string]: unknown };
    return pickDriver(module, `The module ${file}`, options);
  }
  if (!FIRST_PARTY_NAME.test(spec)) {
    throw new Error(`${JSON.stringify(spec)} is neither a first-party driver name (lowercase letters, digits and hyphens) nor a module path`);
  }
  // In the published package this file is dist/wire/load-driver.js and drivers live in dist/drivers/;
  // run from source, both are .ts files under src/.
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  const entry = fileURLToPath(new URL(`../drivers/${spec}/index${extension}`, import.meta.url));
  if (!existsSync(entry)) throw new Error(`No first-party driver named ${JSON.stringify(spec)}: ${entry} does not exist`);
  const module = (await import(`../drivers/${spec}/index.ts`)) as { [name: string]: unknown };
  return pickDriver(module, `The first-party driver module ari/drivers/${spec}`, { ...options, name: spec });
}
