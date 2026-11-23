// Repository rules, enforced in the gate. Each violation names the file and the
// rule. The rules:
//
//   no-runtime-dependencies  package.json `dependencies` is empty.
//   no-host-names            no host product names in src/, spec/, json-schema/,
//                            test/, scripts/, clients/ or any shipped file.
//   browser-safe-entries     nothing statically reachable from any entry of
//                            `ari`, `ari/host`, `ari/conformance`,
//                            `ari/cli-manifests` or `ari/meta/*` imports a Node
//                            built-in. Every export condition counts except
//                            `types`: the `development` source and the shipped
//                            `default` file alike.
//   no-static-optional-imports  no source file in src/ (.ts, .mts, .cts, .tsx,
//                            .js, .mjs, .cjs, .jsx) statically imports or
//                            `require`s `effect` or a vendor SDK listed in
//                            peerDependencies. Type-only imports are erased and
//                            allowed.
//   dist-imports             a built file in dist/ (.js, .mjs, .cjs) loads no
//                            bare package, except a Node built-in inside a
//                            Node-only subpath, or a dynamic `import()` of a
//                            declared optional peer.
//
// Dynamic imports in dist/ whose specifier is not a string literal: the
// checker resolves the specifier when it provably can, then applies the rule
// above. Provable forms, also when tsc wrapped them in its
// `__rewriteRelativeImportExtension` helper:
//   - a `const` bound once in the file to a string literal;
//   - a template literal that starts with "./", "../" or "/", which stays
//     inside the package;
//   - `pathToFileURL(x)` or `pathToFileURL(x).href`, with `pathToFileURL`
//     imported from "node:url" or "url": a file URL names a file, never a
//     package, whatever `x` holds. Use this to load a module the host names at
//     runtime (the `ari-driver` runner loads any driver by module path).
// Any other specifier, including a `require()` with a computed argument, is a
// violation. No comment or other annotation overrides this.
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

/** Source files rule no-static-optional-imports reads. Declaration files are skipped. */
export const SOURCE_EXTENSIONS = [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"];

/** Built files rule dist-imports reads. */
export const DIST_EXTENSIONS = [".js", ".mjs", ".cjs"];

const TSC_REWRITE_HELPER = "__rewriteRelativeImportExtension";

/** The specifier the checker assigns to a provable file URL; it counts as a local file. */
const FILE_URL_SPECIFIER = "file:";

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

/** One place a file loads another module. */
export interface ImportSite {
  /** The module specifier, or undefined when it cannot be determined without running the code. */
  readonly specifier: string | undefined;
  /** True for `import()`, and for `require()` with a non-literal argument. */
  readonly dynamic: boolean;
  readonly typeOnly: boolean;
  readonly line: number;
  /** The argument's source text, for messages. */
  readonly expression: string;
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

function isDeclarationFile(file: string): boolean {
  return /\.d\.[cm]?ts$/.test(file);
}

function hasExtension(file: string, extensions: readonly string[]): boolean {
  return !isDeclarationFile(file) && extensions.some((extension) => file.endsWith(extension));
}

function readPackageJson(root: string): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (/\.[cm]?ts$/.test(fileName)) return ts.ScriptKind.TS;
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

/** One binding of a name in a file. */
interface Binding {
  /** The string a `const` with a literal initializer provably holds. */
  readonly value?: string;
  /** For an import binding: the module and the imported name (`*` for a namespace, `default` for a default import). */
  readonly importOf?: { readonly module: string; readonly name: string };
}

/** Every binding of every name in the file. A name bound more than once is never trusted. */
function fileBindings(source: ts.SourceFile): Map<string, Binding[]> {
  const bindings = new Map<string, Binding[]>();
  const bind = (name: ts.Node, binding: Binding): void => {
    if (ts.isIdentifier(name)) {
      const list = bindings.get(name.text) ?? [];
      list.push(binding);
      bindings.set(name.text, list);
    } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) bind(element.name, {});
      }
    }
  };
  const moduleOf = (node: ts.Node): string | undefined => {
    let current: ts.Node | undefined = node;
    while (current !== undefined && !ts.isImportDeclaration(current)) current = current.parent;
    return current !== undefined && ts.isStringLiteral(current.moduleSpecifier) ? current.moduleSpecifier.text : undefined;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const isConst = (ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) !== 0;
      const initializer = node.initializer;
      const literal = initializer !== undefined && ts.isStringLiteralLike(initializer) ? initializer.text : undefined;
      bind(node.name, isConst && literal !== undefined ? { value: literal } : {});
    } else if (ts.isParameter(node) || ts.isBindingElement(node)) {
      bind(node.name, {});
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node)) &&
      node.name !== undefined
    ) {
      bind(node.name, {});
    } else if (ts.isImportClause(node) && node.name !== undefined) {
      const module = moduleOf(node);
      bind(node.name, module === undefined ? {} : { importOf: { module, name: "default" } });
    } else if (ts.isNamespaceImport(node)) {
      const module = moduleOf(node);
      bind(node.name, module === undefined ? {} : { importOf: { module, name: "*" } });
    } else if (ts.isImportSpecifier(node)) {
      const module = moduleOf(node);
      const imported = (node.propertyName ?? node.name).text;
      bind(node.name, module === undefined ? {} : { importOf: { module, name: imported } });
    } else if (ts.isImportEqualsDeclaration(node)) {
      bind(node.name, {});
    } else if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
      bind(node.variableDeclaration.name, {});
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bindings;
}

function onlyBinding(bindings: Map<string, Binding[]>, name: string): Binding | undefined {
  const list = bindings.get(name);
  return list !== undefined && list.length === 1 ? list[0] : undefined;
}

function isNodeUrlModule(module: string): boolean {
  return module === "node:url" || module === "url";
}

/** True when `callee` is node:url's `pathToFileURL`, imported by name or reached through a namespace or default import. */
function isPathToFileUrl(callee: ts.Expression, bindings: Map<string, Binding[]>): boolean {
  if (ts.isIdentifier(callee)) {
    const importOf = onlyBinding(bindings, callee.text)?.importOf;
    return importOf !== undefined && isNodeUrlModule(importOf.module) && importOf.name === "pathToFileURL";
  }
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === "pathToFileURL" && ts.isIdentifier(callee.expression)) {
    const importOf = onlyBinding(bindings, callee.expression.text)?.importOf;
    return importOf !== undefined && isNodeUrlModule(importOf.module) && (importOf.name === "*" || importOf.name === "default");
  }
  return false;
}

/** The specifier an argument provably names, or undefined when that cannot be known statically. */
function staticSpecifier(argument: ts.Expression, bindings: Map<string, Binding[]>): string | undefined {
  if (ts.isStringLiteralLike(argument)) return argument.text;
  if (ts.isTemplateExpression(argument)) {
    const head = argument.head.text;
    // A template that starts with a relative or absolute path stays inside the package, whatever follows.
    return head.startsWith("./") || head.startsWith("../") || head.startsWith("/") ? head : undefined;
  }
  if (ts.isParenthesizedExpression(argument)) return staticSpecifier(argument.expression, bindings);
  // tsc with `rewriteRelativeImportExtensions` wraps a non-literal specifier in
  // this helper, which changes only relative `.ts` paths; look through it.
  if (
    ts.isCallExpression(argument) &&
    ts.isIdentifier(argument.expression) &&
    argument.expression.text === TSC_REWRITE_HELPER &&
    argument.arguments.length > 0
  ) {
    return staticSpecifier(argument.arguments[0]!, bindings);
  }
  if (ts.isIdentifier(argument)) return onlyBinding(bindings, argument.text)?.value;
  // `pathToFileURL(x)` or `pathToFileURL(x).href`: a file URL, which loads a file and never a package.
  const fileUrlCall = ts.isPropertyAccessExpression(argument) && argument.name.text === "href" ? argument.expression : argument;
  if (ts.isCallExpression(fileUrlCall) && isPathToFileUrl(fileUrlCall.expression, bindings)) return FILE_URL_SPECIFIER;
  return undefined;
}

/**
 * Every place a TypeScript or JavaScript file loads a module: import and
 * export-from declarations, `import x = require()`, `require()` calls, and
 * `import()` calls, with the specifier resolved where it provably can be.
 */
export function findImports(fileName: string, text: string): ImportSite[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const bindings = fileBindings(source);
  const sites: ImportSite[] = [];
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const add = (node: ts.Node, specifier: string | undefined, dynamic: boolean, typeOnly: boolean, argument: ts.Node): void => {
    sites.push({ specifier, dynamic, typeOnly, line: lineOf(node), expression: argument.getText(source) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node, node.moduleSpecifier.text, false, node.importClause?.isTypeOnly === true, node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node, node.moduleSpecifier.text, false, node.isTypeOnly, node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      add(node, node.moduleReference.expression.text, false, node.isTypeOnly, node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const argument = node.arguments[0]!;
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isImport || isRequire) {
        const specifier = staticSpecifier(argument, bindings);
        // A `require` with a literal is a static load; one with a computed argument is as dynamic as `import()`.
        const dynamic = isImport || specifier === undefined;
        add(node, specifier, dynamic, false, argument);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

/** A specifier that loads a file of this package or of the file system, never an installed package. */
function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/") || specifier.startsWith(FILE_URL_SPECIFIER);
}

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || NODE_BUILTINS.has(specifier);
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

/** The file a relative specifier loads, trying the source extension for a built one (`.js` to `.ts`). */
function resolveRelative(root: string, fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(path.join(root, fromFile)), specifier);
  const candidates = [base];
  const swaps: Array<[string, string[]]> = [
    [".js", [".ts", ".tsx"]],
    [".mjs", [".mts"]],
    [".cjs", [".cts"]],
    [".jsx", [".tsx"]],
  ];
  for (const [built, sources] of swaps) {
    if (base.endsWith(built)) candidates.push(...sources.map((extension) => base.slice(0, -built.length) + extension));
  }
  candidates.push(...SOURCE_EXTENSIONS.map((extension) => base + extension));
  candidates.push(...SOURCE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)));
  const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  return found === undefined ? undefined : toPosix(path.relative(root, found));
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

/** Every target of an export entry, by condition. A string entry counts as `default`. */
function exportTargets(pkg: PackageJson, subpath: string): Array<{ condition: string; target: string }> {
  const entry = pkg.exports?.[subpath];
  if (entry === undefined) return [];
  if (typeof entry === "string") return [{ condition: "default", target: entry }];
  return Object.entries(entry).map(([condition, target]) => ({ condition, target }));
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
    for (const { condition, target } of exportTargets(pkg, subpath)) {
      // Type declarations are erased; every other condition is code a consumer may load.
      if (condition === "types") continue;
      for (const file of filesForTarget(root, target)) {
        queue.push({ file, entry: `exports["${subpath}"].${condition} (${file})` });
      }
    }
  }
  while (queue.length > 0) {
    const { file, entry } = queue.shift()!;
    if (seen.has(file) || isDeclarationFile(file)) continue;
    seen.add(file);
    for (const site of findImports(file, fs.readFileSync(path.join(root, file), "utf8"))) {
      if (site.dynamic || site.typeOnly || site.specifier === undefined) continue;
      if (isNodeBuiltin(site.specifier)) {
        violations.push({
          rule: "browser-safe-entries",
          file,
          message: `line ${site.line} imports Node built-in "${site.specifier}", reachable from browser-safe entry ${entry}`,
        });
      } else if (isRelative(site.specifier)) {
        const resolved = resolveRelative(root, file, site.specifier);
        if (resolved !== undefined) queue.push({ file: resolved, entry });
      }
    }
  }
  return violations;
}

function checkOptionalImports(root: string, pkg: PackageJson): RuleViolation[] {
  const forbidden = new Set(["effect", ...Object.keys(pkg.peerDependencies ?? {})]);
  const violations: RuleViolation[] = [];
  for (const full of walk(path.join(root, "src"))) {
    if (!hasExtension(full, SOURCE_EXTENSIONS)) continue;
    const file = toPosix(path.relative(root, full));
    for (const site of findImports(file, fs.readFileSync(full, "utf8"))) {
      if (site.dynamic || site.typeOnly || site.specifier === undefined || isRelative(site.specifier)) continue;
      if (forbidden.has(packageName(site.specifier))) {
        violations.push({
          rule: "no-static-optional-imports",
          file,
          message: `line ${site.line} statically loads optional peer "${site.specifier}"; load it with a dynamic import() when used`,
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
    const target = exportTargets(pkg, subpath).find((candidate) => candidate.condition === "default")?.target;
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
    if (!hasExtension(full, DIST_EXTENSIONS)) continue;
    const file = toPosix(path.relative(root, full));
    const inNodeOnlySubpath = nodeOnly.some((prefix) => file.startsWith(prefix));
    const violation = (line: number, message: string): void => {
      violations.push({ rule: "dist-imports", file, message: `line ${line} ${message}` });
    };
    for (const site of findImports(file, fs.readFileSync(full, "utf8"))) {
      if (site.specifier === undefined) {
        violation(
          site.line,
          `loads a module chosen at runtime (${site.expression}); the specifier must provably be a string literal, a const bound to one, a template starting with ./ or ../, or node:url's pathToFileURL(...)`,
        );
        continue;
      }
      if (isRelative(site.specifier)) continue;
      if (isNodeBuiltin(site.specifier)) {
        if (!inNodeOnlySubpath) violation(site.line, `imports Node built-in "${site.specifier}" outside a Node-only subpath`);
        continue;
      }
      if (site.dynamic && optionalPeers.has(packageName(site.specifier))) continue;
      violation(
        site.line,
        site.dynamic
          ? `dynamically imports "${site.specifier}", which is not a declared optional peer`
          : `loads package "${site.specifier}" statically; built files may load only Node built-ins (in Node-only subpaths) and optional peers through import()`,
      );
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
