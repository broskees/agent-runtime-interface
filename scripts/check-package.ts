// Package-contents check, run in the gate after the build. It fails when:
//   - the tarball (`npm pack --dry-run`) holds anything outside package.json,
//     README.md, LICENSE, CHANGELOG.md, dist/** and json-schema/**, or lacks
//     package.json, README.md or LICENSE (npm 11 no longer ships CHANGELOG.md
//     on its own, and `files` lists only dist and json-schema);
//   - a src module has no .js, .d.ts or .js.map in the tarball;
//   - an export entry whose source exists has no shipped `types` or `default`
//     file;
//   - package.json lacks a field the packaging rules require;
//   - the root export, bundled and minified for a neutral platform, exceeds
//     the byte budget in scripts/size-budget.json.
//
// Usage: node scripts/check-package.ts [--root <dir>]

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { packedFiles } from "./check-rules.ts";

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
  type?: string;
  sideEffects?: boolean;
  license?: string;
  bin?: Record<string, string>;
  files?: string[];
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  exports?: Record<string, string | Record<string, string>>;
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

/** Every problem with the package at `root`, plus the measured root bundle size. */
export async function checkPackage(root: string, files: readonly string[] = packedFiles(root)): Promise<{ problems: string[]; bytes: number; budget: number }> {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;
  const problems = [...checkManifest(pkg), ...checkTarball(root, pkg, files)];
  const { rootExportMinifiedBytes: budget } = JSON.parse(fs.readFileSync(path.join(root, "scripts", "size-budget.json"), "utf8")) as {
    rootExportMinifiedBytes: number;
  };
  const bytes = await rootBundleBytes(root, pkg);
  if (bytes > budget) {
    problems.push(`the root export bundles to ${bytes} bytes minified, over the budget of ${budget} bytes in scripts/size-budget.json`);
  }
  return { problems, bytes, budget };
}

async function main(argv: string[]): Promise<number> {
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex === -1 ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") : path.resolve(argv[rootIndex + 1] ?? ".");
  const { problems, bytes, budget } = await checkPackage(root);
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    process.stderr.write(`check:package failed with ${problems.length} problem(s).\n`);
    return 1;
  }
  process.stdout.write(`check:package passed: tarball contents are clean; root export is ${bytes} of ${budget} budgeted bytes.\n`);
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
