// Packs the package exactly as it is published.
//
// The repository's package.json sends the `development` export condition to
// src/*.ts, so code inside the repository runs and type-checks without a
// build. The tarball ships no src/, so a published manifest with that
// condition would send `node --conditions=development`, Vite's dev server and
// any other tool that asks for `development` to files that do not exist. The
// published package.json therefore leaves the `development` condition out of
// every export entry, and leaves out `scripts`, whose commands name files the
// tarball does not ship either.
//
// The repository's package.json is never changed. This script copies the
// files `npm pack` would ship into a staging directory, writes the published
// package.json there, and runs `npm pack` in that directory. Tests, the
// package-contents check and the release workflow all pack through it, so
// they see the same tarball a consumer installs. Running `npm pack` or
// `npm publish` in the repository itself is refused by the `prepack` script
// (`--refuse-repository-pack`), because it would ship the repository's
// manifest.
//
// Usage:
//   node scripts/pack.ts --out <dir>                 writes the tarball into <dir> and prints its path
//   node scripts/pack.ts --out <dir> --repository <url>
//                                                    also sets `repository` in the published manifest
//                                                    (the release workflow passes its own GitHub
//                                                    repository, which npm provenance requires)
//   node scripts/pack.ts --refuse-repository-pack    exits 1 with the reason (the `prepack` script)

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The export condition that only the repository resolves: it points at src/, which the tarball does not ship. */
export const REPOSITORY_ONLY_CONDITION = "development";

type ExportEntry = string | { readonly [condition: string]: ExportEntry };

export interface Manifest {
  readonly [field: string]: unknown;
  readonly name?: string;
  readonly version?: string;
  readonly exports?: { readonly [subpath: string]: ExportEntry };
  readonly scripts?: { readonly [name: string]: string };
  readonly dependencies?: { readonly [name: string]: string };
}

export interface PublishOptions {
  /** The source repository URL to record as `repository` (npm provenance needs it to match the workflow's repository). */
  readonly repository?: string;
}

function withoutRepositoryOnlyCondition(entry: ExportEntry): ExportEntry {
  if (typeof entry === "string") return entry;
  const kept: { [condition: string]: ExportEntry } = {};
  for (const [condition, target] of Object.entries(entry)) {
    if (condition === REPOSITORY_ONLY_CONDITION) continue;
    kept[condition] = withoutRepositoryOnlyCondition(target);
  }
  return kept;
}

/** The package.json that is published: the repository's, minus the `development` condition and `scripts`. */
export function publishedManifest(manifest: Manifest, options: PublishOptions = {}): Manifest {
  const published: { [field: string]: unknown } = {};
  for (const [field, value] of Object.entries(manifest)) {
    if (field === "scripts") continue;
    if (field === "exports" && value !== undefined) {
      const exports: { [subpath: string]: ExportEntry } = {};
      for (const [subpath, entry] of Object.entries(value as { [subpath: string]: ExportEntry })) exports[subpath] = withoutRepositoryOnlyCondition(entry);
      published[field] = exports;
      continue;
    }
    published[field] = value;
  }
  if (options.repository !== undefined) published["repository"] = { type: "git", url: options.repository };
  return published;
}

function runNpm(args: readonly string[], cwd: string): string {
  const result = spawnSync("npm", [...args], { cwd, encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args.join(" ")} failed in ${cwd} (exit ${result.status}): ${result.stderr}`);
  return result.stdout;
}

/** The files `npm pack` ships from `directory`, relative to it, read without running any script. */
export function packFileList(directory: string): string[] {
  const output = runNpm(["pack", "--dry-run", "--json", "--ignore-scripts"], directory);
  return (JSON.parse(output) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((file) => file.path).sort();
}

/**
 * Copies what the package ships from `root` into `stageDirectory` (which must
 * be empty or absent), with the published package.json in place of the
 * repository's. Returns the published manifest.
 */
export function stagePackage(root: string, stageDirectory: string, options: PublishOptions = {}): Manifest {
  if (fs.existsSync(stageDirectory) && fs.readdirSync(stageDirectory).length > 0) throw new Error(`the staging directory ${stageDirectory} is not empty`);
  fs.mkdirSync(stageDirectory, { recursive: true });
  for (const file of packFileList(root)) {
    if (file === "package.json") continue;
    const target = path.join(stageDirectory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file), target);
  }
  const manifest = publishedManifest(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as Manifest, options);
  fs.writeFileSync(path.join(stageDirectory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export interface PackedPackage {
  /** Absolute path of the tarball. */
  readonly tarball: string;
  /** The files it holds, relative to the package root. */
  readonly files: readonly string[];
  /** The package.json it holds. */
  readonly manifest: Manifest;
}

/** Packs the package at `root` as it is published, writing the tarball into `destination`. */
export function packPackage(root: string, destination: string, options: PublishOptions = {}): PackedPackage {
  const stageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ari-stage-"));
  try {
    const manifest = stagePackage(root, stageDirectory, options);
    fs.mkdirSync(destination, { recursive: true });
    const output = runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", path.resolve(destination)], stageDirectory);
    const [packed] = JSON.parse(output) as Array<{ filename: string; files: Array<{ path: string }> }>;
    return { tarball: path.join(path.resolve(destination), packed!.filename), files: packed!.files.map((file) => file.path).sort(), manifest };
  } finally {
    fs.rmSync(stageDirectory, { recursive: true, force: true });
  }
}

/**
 * What the package ships, as `packPackage` would pack it, without writing a
 * tarball: the published manifest and the tarball's file list.
 */
export function stagedContents(root: string, options: PublishOptions = {}): { readonly manifest: Manifest; readonly files: readonly string[] } {
  const stageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ari-stage-"));
  try {
    const manifest = stagePackage(root, stageDirectory, options);
    return { manifest, files: packFileList(stageDirectory) };
  } finally {
    fs.rmSync(stageDirectory, { recursive: true, force: true });
  }
}

export const REFUSE_REPOSITORY_PACK_MESSAGE =
  "Refusing to pack the repository directly: its package.json sends the `development` export condition to src/, which the tarball does not ship. " +
  "Pack with `node scripts/pack.ts --out <dir>`, which writes the published package.json; publish the tarball it prints.";

function main(argv: readonly string[]): number {
  if (argv.includes("--refuse-repository-pack")) {
    process.stderr.write(`${REFUSE_REPOSITORY_PACK_MESSAGE}\n`);
    return 1;
  }
  const valueOf = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const out = valueOf("--out");
  if (out === undefined) {
    process.stderr.write("Usage: node scripts/pack.ts --out <dir> [--repository <url>]\n");
    return 2;
  }
  const repository = valueOf("--repository");
  const packed = packPackage(REPOSITORY_ROOT, out, repository === undefined ? {} : { repository });
  process.stdout.write(`${packed.tarball}\n`);
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
