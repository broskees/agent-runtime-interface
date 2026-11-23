// Repository rules, enforced in the gate. Each violation names the file and the
// rule. The rules:
//
//   no-runtime-dependencies  package.json `dependencies` is empty.
//   no-host-names            no host product names in src/, spec/, json-schema/,
//                            test/, scripts/, clients/ or any shipped file.
//   browser-safe-entries     nothing statically reachable from the entries of
//                            `ari`, `ari/host`, `ari/conformance`,
//                            `ari/cli-manifests` or `ari/meta/*` imports a Node
//                            built-in.
//   no-static-optional-imports  nothing in src/ statically imports `effect` or a
//                            vendor SDK listed in peerDependencies (type-only
//                            imports are erased and allowed).
//   dist-imports             a built dist file imports no bare package, except a
//                            Node built-in inside a Node-only subpath, or a
//                            dynamic `import()` of a declared optional peer.
//
// Usage: node scripts/check-rules.ts [--root <dir>]

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { builtinModules } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export type RuleName =
  | "no-runtime-dependencies"
  | "no-host-names"
  | "browser-safe-entries"
  | "no-static-optional-imports"
  | "dist-imports";

export interface RuleViolation {
  readonly rule: RuleName;
  /** Path relative to the repository root, with forward slashes. */
  readonly file: string;
  readonly message: string;
}

export interface CheckOptions {
  readonly root: string;
  /** Files the package tarball ships, relative to `root`. Defaults to `npm pack --dry-run`. */
  readonly tarballFiles?: readonly string[];
}

/** Subpaths whose entries must stay browser-safe. */
export const BROWSER_SAFE_SUBPATHS = [".", "./host", "./conformance", "./cli-manifests", "./meta/*"];

/** Directories whose files are scanned for host names, besides shipped files. */
export const HOST_NAME_DIRECTORIES = ["src", "spec", "json-schema", "test", "scripts", "clients"];

// The banned host names, written so that this file does not match them.
const HOST_NAME_PATTERNS: readonly RegExp[] = [
  /t[3]code/i,
  /t[3]tools/i,
  /t[3] code/i,
  /\bt[3]\b/i,
  /orchestration[v]2/i,
  /server[s]ettings/i,
  /provider[h]ost/i,
];

const SKIPPED_DIRECTORIES = new Set(["node_modules", "target", ".venv", "__pycache__", ".git"]);
const NODE_BUILTINS = new Set(builtinModules);

interface PackageJson {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  exports?: Record<string, string | Record<string, string>>;
}

interface ImportSite {
  readonly specifier: string;
  readonly dynamic: boolean;
  readonly typeOnly: boolean;
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join("/");
}

function walk(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) results.push(...walk(path.join(directory, entry.name)));
    } else if (entry.isFile()) {
      results.push(path.join(directory, entry.name));
    }
  }
  return results.sort();
}

function readPackageJson(root: string): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;
}

/** Every import in a TypeScript or JavaScript file: static, re-export and literal dynamic `import()`. */
export function findImports(fileName: string, text: string): ImportSite[] {
  const kind = fileName.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, kind);
  const sites: ImportSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      sites.push({ specifier: node.moduleSpecifier.text, dynamic: false, typeOnly: node.importClause?.isTypeOnly === true });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      sites.push({ specifier: node.moduleSpecifier.text, dynamic: false, typeOnly: node.isTypeOnly });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]!)
    ) {
      sites.push({ specifier: (node.arguments[0] as ts.StringLiteralLike).text, dynamic: true, typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/");
}

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || NODE_BUILTINS.has(specifier);
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

function checkDependencies(pkg: PackageJson): RuleViolation[] {
  const dependencies = Object.keys(pkg.dependencies ?? {});
  if (dependencies.length === 0) return [];
  return [
    {
      rule: "no-runtime-dependencies",
      file: "package.json",
      message: `"dependencies" must be empty; found ${dependencies.join(", ")}`,
    },
  ];
}

function checkHostNames(root: string, tarballFiles: readonly string[]): RuleViolation[] {
  const files = new Set<string>();
  for (const directory of HOST_NAME_DIRECTORIES) {
    for (const full of walk(path.join(root, directory))) files.add(toPosix(path.relative(root, full)));
  }
  for (const relative of tarballFiles) files.add(relative);
  const violations: RuleViolation[] = [];
  for (const relative of [...files].sort()) {
    const full = path.join(root, relative);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, "utf8");
    for (const pattern of HOST_NAME_PATTERNS) {
      const match = pattern.exec(text);
      if (match === null) continue;
      const line = text.slice(0, match.index).split("\n").length;
      violations.push({ rule: "no-host-names", file: relative, message: `line ${line} names a host product ("${match[0]}")` });
    }
  }
  return violations;
}

function exportTarget(pkg: PackageJson, subpath: string, condition: string): string | undefined {
  const entry = pkg.exports?.[subpath];
  if (typeof entry === "string") return entry;
  return entry?.[condition];
}

/** Files that exist and match an export target, which may contain one `*`. */
function filesForTarget(root: string, target: string): string[] {
  const normalized = target.replace(/^\.\//, "");
  const star = normalized.indexOf("*");
  if (star === -1) return fs.existsSync(path.join(root, normalized)) ? [normalized] : [];
  const prefix = normalized.slice(0, star);
  const suffix = normalized.slice(star + 1);
  return walk(path.join(root, path.posix.dirname(prefix + "x")))
    .map((full) => toPosix(path.relative(root, full)))
    .filter((relative) => relative.startsWith(prefix) && relative.endsWith(suffix) && relative.length > prefix.length + suffix.length);
}

function checkBrowserSafeEntries(root: string, pkg: PackageJson): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const seen = new Set<string>();
  const queue: Array<{ file: string; entry: string }> = [];
  for (const subpath of BROWSER_SAFE_SUBPATHS) {
    const target = exportTarget(pkg, subpath, "development");
    if (target === undefined) continue;
    for (const entry of filesForTarget(root, target)) queue.push({ file: entry, entry });
  }
  while (queue.length > 0) {
    const { file, entry } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const full = path.join(root, file);
    for (const site of findImports(file, fs.readFileSync(full, "utf8"))) {
      if (site.dynamic || site.typeOnly) continue;
      if (isNodeBuiltin(site.specifier)) {
        violations.push({
          rule: "browser-safe-entries",
          file,
          message: `imports Node built-in "${site.specifier}", reachable from browser-safe entry ${entry}`,
        });
      } else if (isRelative(site.specifier)) {
        const resolved = toPosix(path.relative(root, path.resolve(path.dirname(full), site.specifier)));
        const candidate = resolved.endsWith(".js") ? `${resolved.slice(0, -3)}.ts` : resolved;
        if (fs.existsSync(path.join(root, candidate))) queue.push({ file: candidate, entry });
      }
    }
  }
  return violations;
}

function checkOptionalImports(root: string, pkg: PackageJson): RuleViolation[] {
  const forbidden = new Set(["effect", ...Object.keys(pkg.peerDependencies ?? {})]);
  const violations: RuleViolation[] = [];
  for (const full of walk(path.join(root, "src"))) {
    if (!full.endsWith(".ts")) continue;
    const file = toPosix(path.relative(root, full));
    for (const site of findImports(file, fs.readFileSync(full, "utf8"))) {
      if (site.dynamic || site.typeOnly || isRelative(site.specifier)) continue;
      if (forbidden.has(packageName(site.specifier))) {
        violations.push({
          rule: "no-static-optional-imports",
          file,
          message: `statically imports optional peer "${site.specifier}"; load it with a dynamic import() when used`,
        });
      }
    }
  }
  return violations;
}

function nodeOnlyDistPrefixes(pkg: PackageJson): string[] {
  const prefixes: string[] = [];
  for (const subpath of Object.keys(pkg.exports ?? {})) {
    if (BROWSER_SAFE_SUBPATHS.includes(subpath) || subpath.startsWith("./json-schema")) continue;
    const target = exportTarget(pkg, subpath, "default");
    if (target === undefined) continue;
    const normalized = target.replace(/^\.\//, "");
    const cut = normalized.includes("*") ? normalized.slice(0, normalized.indexOf("*")) : normalized.slice(0, normalized.lastIndexOf("/") + 1);
    if (cut !== "dist/" && cut !== "") prefixes.push(cut);
  }
  return prefixes;
}

function checkDistImports(root: string, pkg: PackageJson): RuleViolation[] {
  const optionalPeers = new Set(
    Object.keys(pkg.peerDependencies ?? {}).filter((name) => pkg.peerDependenciesMeta?.[name]?.optional === true),
  );
  const nodeOnly = nodeOnlyDistPrefixes(pkg);
  const violations: RuleViolation[] = [];
  for (const full of walk(path.join(root, "dist"))) {
    if (!full.endsWith(".js")) continue;
    const file = toPosix(path.relative(root, full));
    const inNodeOnlySubpath = nodeOnly.some((prefix) => file.startsWith(prefix));
    for (const site of findImports(file, fs.readFileSync(full, "utf8"))) {
      if (isRelative(site.specifier)) continue;
      if (isNodeBuiltin(site.specifier)) {
        if (inNodeOnlySubpath) continue;
        violations.push({ rule: "dist-imports", file, message: `imports Node built-in "${site.specifier}" outside a Node-only subpath` });
        continue;
      }
      if (site.dynamic && optionalPeers.has(packageName(site.specifier))) continue;
      violations.push({
        rule: "dist-imports",
        file,
        message: site.dynamic
          ? `dynamically imports "${site.specifier}", which is not a declared optional peer`
          : `imports package "${site.specifier}"; built files may import only Node built-ins (in Node-only subpaths) and optional peers through import()`,
      });
    }
  }
  return violations;
}

/** Files `npm pack` would put in the tarball, relative to `root`. */
export function packedFiles(root: string): string[] {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`npm pack --dry-run failed: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as Array<{ files: Array<{ path: string }> }>;
  return (parsed[0]?.files ?? []).map((file) => file.path).sort();
}

export function checkRepository(options: CheckOptions): RuleViolation[] {
  const { root } = options;
  const pkg = readPackageJson(root);
  const tarballFiles = options.tarballFiles ?? packedFiles(root);
  return [
    ...checkDependencies(pkg),
    ...checkHostNames(root, tarballFiles),
    ...checkBrowserSafeEntries(root, pkg),
    ...checkOptionalImports(root, pkg),
    ...checkDistImports(root, pkg),
  ];
}

function main(argv: string[]): number {
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex === -1 ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") : path.resolve(argv[rootIndex + 1] ?? ".");
  const violations = checkRepository({ root });
  if (violations.length === 0) {
    process.stdout.write("check:rules passed: all five repository rules hold.\n");
    return 0;
  }
  for (const violation of violations) {
    process.stderr.write(`${violation.file}: [${violation.rule}] ${violation.message}\n`);
  }
  process.stderr.write(`check:rules failed with ${violations.length} violation(s).\n`);
  return 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
