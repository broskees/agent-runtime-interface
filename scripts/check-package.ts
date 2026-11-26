// Package-contents check, run in the gate after the build. It reads the
// tarball as it is published: scripts/pack.ts stages the shipped files with
// the published package.json, and `npm pack --dry-run` lists what that stage
// would ship. It fails when:
//   - the tarball holds anything outside package.json, README.md, LICENSE,
//     CHANGELOG.md, dist/** and json-schema/**, or lacks package.json,
//     README.md or LICENSE (npm 11 no longer ships CHANGELOG.md on its own,
//     and `files` lists only dist and json-schema);
//   - a src module has no .js, .d.ts or .js.map in the tarball;
//   - an export entry whose source exists has no shipped `types` or `default`
//     file;
//   - the repository's package.json lacks a field the packaging rules require;
//   - the published package.json sends any export condition, or the bin, to
//     a file the tarball does not ship (the repository's `development`
//     condition points at src/, so the published manifest must leave it
//     out), or has runtime dependencies;
//   - the root export, bundled and minified for a neutral platform, exceeds
//     the byte budget in scripts/size-budget.json;
//   - a shipped file holds code of the Claude Agent SDK, found by a string
//     unique to its sdk.mjs (CLAUDE_SDK_CODE_MARKER). The SDK's licence is
//     Anthropic's, not MIT, so ARI never redistributes it.
//
// Usage: node scripts/check-package.ts [--root <dir>] [--tarball <file.tgz>]
//   --tarball checks that tarball's own package.json and file list instead of
//   staging one; the release workflow runs it on the tarball it publishes.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { build } from "esbuild";
import { stagedContents } from "./pack.ts";

/**
 * A string unique to the Claude Agent SDK's sdk.mjs: the environment variable
 * it sets for every Claude Code process it starts. ARI's own code never names
 * it, so a shipped file (or the standalone `ari-driver`) that contains it
 * holds the SDK's code.
 */
export const CLAUDE_SDK_CODE_MARKER = "CLAUDE_CODE_SDK_READS_SESSION_STATE";

const ALLOWED_EXACT = ["package.json", "README.md", "LICENSE", "CHANGELOG.md"];
const REQUIRED_EXACT = ["package.json", "README.md", "LICENSE"];
const ALLOWED_PREFIXES = ["dist/", "json-schema/"];
const OPTIONAL_PEERS = ["effect", "@anthropic-ai/claude-agent-sdk", "@cursor/sdk", "@opencode-ai/sdk", "@opencode/client", "@muse-code/sdk"];
const EXPORT_SUBPATHS = [
  ".",
  "./host",
  "./driver-kit",
  "./node",
  "./wire",
  "./conformance",
  "./effect",
  "./drivers/*",
  "./meta/*",
  "./cli-manifests",
  "./json-schema/*",
];

export interface PackageJson {
  name?: string;
  type?: string;
  sideEffects?: boolean;
  license?: string;
  bin?: Record<string, string>;
  files?: string[];
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  exports?: Record<string, string | Record<string, string>>;
  scripts?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

function walk(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join("/");
}

/** Problems with the package.json fields the packaging rules require. */
export function checkManifest(pkg: PackageJson): string[] {
  const problems: string[] = [];
  const expect = (condition: boolean, message: string): void => {
    if (!condition) problems.push(`package.json: ${message}`);
  };
  expect(pkg.type === "module", `"type" must be "module"`);
  expect(pkg.sideEffects === false, `"sideEffects" must be false`);
  expect(pkg.license === "MIT", `"license" must be "MIT"`);
  expect(pkg.engines?.node === ">=22.16", `"engines.node" must be ">=22.16"`);
  expect(pkg.bin?.["ari-driver"] === "./dist/wire/cli.js", `"bin" must map ari-driver to ./dist/wire/cli.js`);
  expect(JSON.stringify(pkg.files) === JSON.stringify(["dist", "json-schema"]), `"files" must be ["dist", "json-schema"]`);
  expect(Object.keys(pkg.dependencies ?? {}).length === 0, `"dependencies" must be empty`);
  for (const subpath of EXPORT_SUBPATHS) {
    const entry = pkg.exports?.[subpath];
    if (subpath === "./json-schema/*") {
      expect(entry === "./json-schema/*", `exports["${subpath}"] must be "./json-schema/*"`);
      continue;
    }
    const conditions = typeof entry === "object" ? Object.keys(entry) : [];
    expect(
      JSON.stringify(conditions) === JSON.stringify(["development", "types", "default"]),
      `exports["${subpath}"] must have development, types and default conditions, in that order`,
    );
  }
  for (const peer of OPTIONAL_PEERS) {
    expect(pkg.peerDependencies?.[peer] !== undefined, `peerDependencies must list ${peer}`);
    expect(pkg.peerDependenciesMeta?.[peer]?.optional === true, `peerDependenciesMeta must mark ${peer} optional`);
  }
  return problems;
}

/** Problems with the tarball's file list `files` for the package at `root`. */
export function checkTarball(root: string, pkg: PackageJson, files: readonly string[]): string[] {
  const problems: string[] = [];
  const shipped = new Set(files);
  for (const file of files) {
    if (!ALLOWED_EXACT.includes(file) && !ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix))) {
      problems.push(`tarball holds ${file}, which is outside the allowed contents`);
    }
  }
  for (const required of REQUIRED_EXACT) {
    if (!shipped.has(required)) problems.push(`tarball lacks ${required}`);
  }
  for (const full of walk(path.join(root, "src"))) {
    if (!full.endsWith(".ts")) continue;
    const base = toPosix(path.relative(path.join(root, "src"), full)).slice(0, -".ts".length);
    for (const extension of [".js", ".d.ts", ".js.map"]) {
      if (!shipped.has(`dist/${base}${extension}`)) problems.push(`tarball lacks dist/${base}${extension} for src/${base}.ts`);
    }
  }
  for (const [subpath, entry] of Object.entries(pkg.exports ?? {})) {
    if (typeof entry !== "object") continue;
    const development = entry.development?.replace(/^\.\//, "");
    if (development === undefined) continue;
    const star = development.indexOf("*");
    const sources = star === -1
      ? (fs.existsSync(path.join(root, development)) ? [development] : [])
      : walk(path.join(root, path.posix.dirname(development.slice(0, star) + "x")))
          .map((full) => toPosix(path.relative(root, full)))
          .filter((relative) => relative.startsWith(development.slice(0, star)) && relative.endsWith(development.slice(star + 1)));
    for (const source of sources) {
      const wildcard = star === -1 ? "" : source.slice(star, source.length - (development.length - star - 1));
      for (const condition of ["types", "default"]) {
        const target = entry[condition]?.replace(/^\.\//, "").replace("*", wildcard);
        if (target === undefined || !shipped.has(target)) {
          problems.push(`exports["${subpath}"].${condition} for ${source} is not in the tarball (${target ?? "missing"})`);
        }
      }
    }
  }
  return problems;
}

// The wildcard values of a `*` pattern target such as
// `./dist/drivers/*/index.js` that name a shipped file, as Node matches them:
// `*` stands for any string, slashes included.
function wildcardMatches(target: string, shipped: readonly string[]): Set<string> {
  const pattern = target.replace(/^\.\//, "");
  const star = pattern.indexOf("*");
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  const values = new Set<string>();
  for (const file of shipped) {
    if (file.length >= prefix.length + suffix.length && file.startsWith(prefix) && file.endsWith(suffix)) values.add(file.slice(prefix.length, file.length - suffix.length));
  }
  return values;
}

/** Every condition of an export entry with its target, nested conditions joined by dots; a string entry is condition `(string)`. */
function conditionTargets(entry: unknown, prefix = ""): Array<{ condition: string; target: string }> {
  if (typeof entry === "string") return [{ condition: prefix === "" ? "(string)" : prefix, target: entry }];
  if (entry === null || typeof entry !== "object") return [];
  return Object.entries(entry as Record<string, unknown>).flatMap(([condition, target]) => conditionTargets(target, prefix === "" ? condition : `${prefix}.${condition}`));
}

/**
 * Problems with the package.json a consumer installs, given the files the
 * tarball holds: an export condition or bin entry that names a file the
 * tarball does not ship, or a runtime dependency. For a `*` subpath, every
 * value that any condition resolves must resolve under every condition, so a
 * condition pointing at unshipped sources fails even though other conditions
 * still work.
 */
export function checkPublishedManifest(published: PackageJson, files: readonly string[]): string[] {
  const problems: string[] = [];
  const shipped = new Set(files);
  for (const [subpath, entry] of Object.entries(published.exports ?? {})) {
    const targets = conditionTargets(entry);
    const exact = targets.filter(({ target }) => !target.includes("*"));
    for (const { condition, target } of exact) {
      if (!shipped.has(target.replace(/^\.\//, ""))) problems.push(`published package.json: exports["${subpath}"] condition ${condition} sends ${target}, which the tarball does not ship`);
    }
    const patterns = targets.filter(({ target }) => target.includes("*")).map((pattern) => ({ ...pattern, values: wildcardMatches(pattern.target, files) }));
    if (patterns.length === 0) continue;
    const reachable = new Set(patterns.flatMap(({ values }) => [...values]));
    if (reachable.size === 0) problems.push(`published package.json: exports["${subpath}"] matches no file the tarball ships`);
    for (const { condition, target, values } of patterns) {
      const missing = [...reachable].filter((value) => !values.has(value)).sort();
      if (missing.length > 0) {
        problems.push(
          `published package.json: exports["${subpath}"] condition ${condition} sends ${missing.length} of ${reachable.size} subpaths to files the tarball does not ship (for example ${target.replace("*", missing[0]!)})`,
        );
      }
    }
  }
  for (const [name, target] of Object.entries(published.bin ?? {})) {
    if (!shipped.has(target.replace(/^\.\//, ""))) problems.push(`published package.json: bin ${name} is ${target}, which the tarball does not ship`);
  }
  if (Object.keys(published.dependencies ?? {}).length > 0) problems.push(`published package.json: "dependencies" must be empty`);
  return problems;
}

/** Size in bytes of the root export, bundled and minified with esbuild for a neutral platform. */
export async function rootBundleBytes(root: string, pkg: PackageJson): Promise<number> {
  const entry = pkg.exports?.["."];
  const target = typeof entry === "object" ? entry.default : entry;
  if (target === undefined) throw new Error(`package.json has no default export for "."`);
  const result = await build({
    entryPoints: [path.join(root, target)],
    bundle: true,
    minify: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles.reduce((total, file) => total + file.contents.byteLength, 0);
}

/** What a tarball holds: its package.json and its files, relative to the package root. */
export interface PackageContents {
  readonly manifest: PackageJson;
  readonly files: readonly string[];
  /** The shipped files whose bytes contain `text` (for a packed tarball, the tarball itself). */
  readonly filesContaining: (text: string) => string[];
}

/** What the package at `root` ships as scripts/pack.ts stages it: the published package.json and the tarball's file list. */
export function publishedContents(root: string): PackageContents {
  const { manifest, files } = stagedContents(root);
  // The stage copies these files from `root` unchanged, except package.json, which holds no code.
  return { manifest: manifest as PackageJson, files, filesContaining: (text) => files.filter((file) => fs.readFileSync(path.join(root, file)).includes(text)) };
}

/** Problems from shipped files that hold the Claude Agent SDK's code. */
export function vendorCodeProblems(contents: PackageContents): string[] {
  return contents.filesContaining(CLAUDE_SDK_CODE_MARKER).map(
    (file) => `${file} holds code of @anthropic-ai/claude-agent-sdk (it contains ${CLAUDE_SDK_CODE_MARKER}, a string unique to the SDK's sdk.mjs); ARI must not redistribute the SDK`,
  );
}

/**
 * Every problem with the package at `root`, plus the measured root bundle
 * size. `contents` is what the tarball holds, by default what
 * scripts/pack.ts stages.
 */
export async function checkPackage(root: string, contents: PackageContents = publishedContents(root)): Promise<{ problems: string[]; bytes: number; budget: number }> {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;
  const problems = [...checkManifest(pkg), ...checkTarball(root, pkg, contents.files), ...checkPublishedManifest(contents.manifest, contents.files), ...vendorCodeProblems(contents)];
  const { rootExportMinifiedBytes: budget } = JSON.parse(fs.readFileSync(path.join(root, "scripts", "size-budget.json"), "utf8")) as {
    rootExportMinifiedBytes: number;
  };
  const bytes = await rootBundleBytes(root, pkg);
  if (bytes > budget) {
    problems.push(`the root export bundles to ${bytes} bytes minified, over the budget of ${budget} bytes in scripts/size-budget.json`);
  }
  return { problems, bytes, budget };
}

function tar(args: readonly string[]): string {
  const result = spawnSync("tar", [...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`tar ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

/** The package.json and the file list (relative to the package root) of an npm tarball. */
export function tarballContents(tarball: string): PackageContents {
  const files = tar(["-tzf", tarball])
    .split("\n")
    .filter((entry) => entry.startsWith("package/") && !entry.endsWith("/"))
    .map((entry) => entry.slice("package/".length))
    .sort();
  const manifest = JSON.parse(tar(["-xzOf", tarball, "package/package.json"])) as PackageJson;
  // A tar archive stores each file's bytes in one piece, so searching the unpacked archive finds a text inside any file.
  const archive = gunzipSync(fs.readFileSync(tarball));
  return { manifest, files, filesContaining: (text) => (archive.includes(text) ? [path.basename(tarball)] : []) };
}

async function main(argv: string[]): Promise<number> {
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex === -1 ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") : path.resolve(argv[rootIndex + 1] ?? ".");
  const tarballIndex = argv.indexOf("--tarball");
  const tarball = tarballIndex === -1 ? undefined : argv[tarballIndex + 1];
  const { problems, bytes, budget } = await checkPackage(root, ...(tarball === undefined ? [] : [tarballContents(tarball)]));
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    process.stderr.write(`check:package failed with ${problems.length} problem(s).\n`);
    return 1;
  }
  process.stdout.write(
    `check:package passed: tarball contents are clean; the published package.json sends every export condition and the bin to a shipped file; root export is ${bytes} of ${budget} budgeted bytes.\n`,
  );
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
