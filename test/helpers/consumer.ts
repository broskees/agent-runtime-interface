// Helpers for tests that use the package the way a consumer does: pack it as
// it is published (scripts/pack.ts, which leaves the repository-only
// `development` export condition out of package.json) and install the
// tarball into a fresh project with npm, offline. Packages a consumer would
// install from the registry beside it, such as `effect` or `@types/node`, are
// packed from this repository's own node_modules at the versions the
// lockfile pins, so no install needs the network.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { packPackage } from "../../scripts/pack.ts";
import type { PackedPackage } from "../../scripts/pack.ts";
import { REPO_ROOT } from "./spec.ts";

/** Consumer tests read dist/; the gate builds before it tests. */
export function requireBuild(): void {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "dist", "index.js")), "dist/ is missing: run `pnpm run build` first (the gate does)");
}

/** Packs the package as it is published into `destination`. */
export function packAsPublished(destination: string): PackedPackage {
  requireBuild();
  return packPackage(REPO_ROOT, destination);
}

/** The directory where Node, resolving from `fromDirectory`, finds the package `name`, with symbolic links resolved. */
function installedDirectory(name: string, fromDirectory: string): string {
  for (const candidate of createRequire(path.join(fromDirectory, "package.json")).resolve.paths(name) ?? []) {
    const directory = path.join(candidate, name);
    if (fs.existsSync(path.join(directory, "package.json"))) return fs.realpathSync(directory);
  }
  throw new Error(`${name} is not installed where ${fromDirectory} would find it`);
}

/**
 * Tarballs, written into `destination`, of the package `name` as this
 * repository has it installed and of every package it depends on, each packed
 * from the directory pnpm installed it in.
 */
export function packRepositoryDependency(name: string, destination: string): string[] {
  const tarballs: string[] = [];
  const packed = new Set<string>();
  const visit = (packageName: string, fromDirectory: string): void => {
    const directory = installedDirectory(packageName, fromDirectory);
    if (packed.has(directory)) return;
    packed.add(directory);
    const output = execFileSync("npm", ["pack", directory, "--json", "--ignore-scripts", "--pack-destination", destination], { cwd: destination, encoding: "utf8" });
    tarballs.push(path.join(destination, (JSON.parse(output) as Array<{ filename: string }>)[0]!.filename));
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency, directory);
  };
  visit(name, REPO_ROOT);
  return tarballs;
}

/** Makes `directory` an ES module project and installs `tarballs` into it with npm, offline and without running scripts. */
export function installConsumer(directory: string, tarballs: readonly string[]): void {
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  execFileSync("npm", ["install", "--offline", "--no-audit", "--no-fund", "--ignore-scripts", ...tarballs], { cwd: directory, encoding: "utf8" });
}

/** Every file under `directory`, relative to it, with `/` separators. */
export function filesUnder(directory: string): string[] {
  return (fs.readdirSync(directory, { recursive: true }) as string[])
    .filter((relative) => fs.statSync(path.join(directory, relative)).isFile())
    .map((relative) => relative.split(path.sep).join("/"))
    .sort();
}

/** The TypeScript compiler this repository pins. */
export const TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");
