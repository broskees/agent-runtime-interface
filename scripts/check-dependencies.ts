// Fails when a package.json has runtime dependencies. The package must ship
// with an empty `dependencies` (proposal §17.1, rule 1), and the release
// workflow runs this check on the repository's package.json before it builds
// and on the packed tarball's own package.json right before it publishes.
//
// It uses only Node built-ins and the system `tar`, so it runs from a bare
// checkout with nothing installed.
//
// Usage: node scripts/check-dependencies.ts <package.json | package .tgz>

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** The package.json text of `file`: the file itself, or `package/package.json` inside an npm tarball. */
export function readManifestText(file: string): string {
  if (!file.endsWith(".tgz")) return fs.readFileSync(file, "utf8");
  const result = spawnSync("tar", ["-xzOf", file, "package/package.json"], { encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`could not read package/package.json from ${file}: ${result.stderr}`);
  return result.stdout;
}

/** The names in the manifest's `dependencies`; empty when it has none. */
export function runtimeDependencies(manifestText: string): string[] {
  const manifest = JSON.parse(manifestText) as { dependencies?: Record<string, string> };
  return Object.keys(manifest.dependencies ?? {}).sort();
}

function main(argv: readonly string[]): number {
  const [file] = argv;
  if (file === undefined) {
    process.stderr.write("Usage: node scripts/check-dependencies.ts <package.json | package .tgz>\n");
    return 2;
  }
  const dependencies = runtimeDependencies(readManifestText(file));
  if (dependencies.length > 0) {
    process.stderr.write(`${file}: "dependencies" must be empty, but it lists ${dependencies.join(", ")}. ARI ships with no runtime dependencies.\n`);
    return 1;
  }
  process.stdout.write(`${file}: no runtime dependencies.\n`);
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
