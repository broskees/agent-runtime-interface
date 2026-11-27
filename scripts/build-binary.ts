// Builds the standalone `ari-driver`: one executable file that serves every
// first-party driver over ari/wire and needs no Node or Bun installed
// (proposal §17.11, rule 1). It is made with `bun build --compile`.
//
//   node scripts/build-binary.ts                      linux-x64, into build/standalone/linux-x64/
//   node scripts/build-binary.ts --target darwin-arm64
//   node scripts/build-binary.ts --target all         the five release platforms
//   node scripts/build-binary.ts --fakes              also the fake Pi and ACP agents, for the host platform
//   node scripts/build-binary.ts --out <dir>          another output root
//
// Targets: linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64.
// Each lands in `<out>/<target>/ari-driver` (`ari-driver.exe` on Windows).
//
// The bundler cannot follow `ari-driver`'s import of a driver by a computed
// name (`../drivers/${name}/index.ts`), so this script writes an entry file
// that imports every directory under src/drivers/ by a literal path and hands
// `runAriDriver` a loader over that table. A driver directory added later is
// picked up without editing anything. A module path (`ari-driver
// ./my-driver.js`) still loads from disk at run time.
//
// The executable cannot import a package by name at run time, so the `claude`
// driver gets the Claude Agent SDK compiled in: the entry hands it a loader
// that imports the pinned `@anthropic-ai/claude-agent-sdk` (the lockfile's
// install under node_modules) by its file path, so Bun bundles that module,
// and the SDK's version and bundled Claude Code version as literals. Only the
// SDK's JavaScript goes in. Its 8 platform packages
// (`@anthropic-ai/claude-agent-sdk-<platform>`, its optionalDependencies, each
// a copy of Claude Code) stay out: the SDK's sdk.mjs resolves one at run time,
// with `createRequire(import.meta.url).resolve()` of a template string and
// only when `pathToClaudeCodeExecutable` is unset, which the driver never
// leaves it, so the bundler cannot see them; they are also `--external`, so
// no SDK release that imports one by name could pull it in. The driver runs
// the user's own `claude`. THIRD-PARTY-NOTICES.md states the SDK's terms; the
// release attaches it beside the binaries. ARI installs nothing: compiling
// the SDK in at build time is not installing it.
//
// The other optional vendor SDKs in `peerDependencies` stay outside the
// bundle; their drivers report the SDK missing in `status()`.
//
// `--fakes` also compiles the fake native agents the end-to-end tests use,
// test/drivers/pi/fake-pi.ts as `pi` and test/drivers/acp/standalone-agent.ts
// as `standalone-acp-agent`, into `<out>/<host target>/fakes/`, so those
// tests run with no Node or Bun on PATH at all.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_SDK_PACKAGE } from "../src/meta/claude.ts";

export const BINARY_TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64"] as const;
export type BinaryTarget = (typeof BINARY_TARGETS)[number];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every first-party driver: the directories under src/drivers/ that hold an index.ts. */
export function firstPartyDrivers(repositoryRoot: string = root): string[] {
  const directory = path.join(repositoryRoot, "src", "drivers");
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(directory, entry.name, "index.ts")))
    .map((entry) => entry.name)
    .sort();
}

/** The pinned Claude Agent SDK the executable compiles in, as the lockfile installed it under node_modules. */
export interface PinnedClaudeSdk {
  /** The absolute path of the SDK's entry module (its package.json `exports["."].default`, sdk.mjs). */
  readonly entry: string;
  readonly version: string;
  /** The Claude Code version the SDK bundles (its package.json `claudeCodeVersion`). */
  readonly claudeCodeVersion: string;
  /** Its platform packages, the optionalDependencies that each hold a copy of Claude Code. */
  readonly platformPackages: readonly string[];
}

function pinnedClaudeSdk(repositoryRoot: string = root): PinnedClaudeSdk {
  const directory = fs.realpathSync(path.join(repositoryRoot, "node_modules", ...CLAUDE_SDK_PACKAGE.split("/")));
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")) as {
    version?: unknown;
    claudeCodeVersion?: unknown;
    exports?: { ".": { default?: unknown } };
    optionalDependencies?: { [name: string]: string };
  };
  const entry = manifest.exports?.["."].default;
  if (typeof entry !== "string" || typeof manifest.version !== "string" || typeof manifest.claudeCodeVersion !== "string") {
    throw new Error(`${path.join(directory, "package.json")} lacks exports["."].default, version or claudeCodeVersion`);
  }
  return {
    entry: path.join(directory, entry),
    version: manifest.version,
    claudeCodeVersion: manifest.claudeCodeVersion,
    platformPackages: Object.keys(manifest.optionalDependencies ?? {}).sort(),
  };
}

/**
 * The entry file's source: a literal import of each driver module and a
 * loader over them. The `claude` entry is its module with the driver exports
 * replaced by one whose loader imports `claudeSdk.entry`, so the SDK is
 * compiled in and loads on first use.
 */
export function entrySource(repositoryRoot: string, drivers: readonly string[], claudeSdk: PinnedClaudeSdk): string {
  const source = (relative: string): string => JSON.stringify(path.join(repositoryRoot, relative));
  const imports = drivers.map((name, index) => `import * as driver${index} from ${source(`src/drivers/${name}/index.ts`)};`);
  const table = drivers.map((name, index) => (name === "claude" ? `  claude: { ...driver${index}, claudeDriver: bundledClaude, default: bundledClaude },` : `  ${JSON.stringify(name)}: driver${index},`));
  const claude = drivers.indexOf("claude");
  const bundledClaude =
    claude === -1
      ? ""
      : `
// The claude driver with ${CLAUDE_SDK_PACKAGE} ${claudeSdk.version} compiled in. Its queries run the user's own claude.
const bundledClaude = driver${claude}.createClaudeDriver({
  loadSdk: async () => ({ sdk: await import(${JSON.stringify(claudeSdk.entry)}), version: ${JSON.stringify(claudeSdk.version)}, claudeCodeVersion: ${JSON.stringify(claudeSdk.claudeCodeVersion)} }),
});
`;
  return `// Written by scripts/build-binary.ts for one build. Do not edit.
import { runAriDriver } from ${source("src/wire/cli.ts")};
import { isModulePath, loadDriver, pickDriver } from ${source("src/wire/load-driver.ts")};
${imports.join("\n")}
${bundledClaude}
const FIRST_PARTY: { readonly [name: string]: { readonly [name: string]: unknown } } = {
${table.join("\n")}
};

async function loadBundledDriver(spec: string, options: { readonly exportName?: string }) {
  if (isModulePath(spec)) return loadDriver(spec, options);
  const module = FIRST_PARTY[spec];
  if (module === undefined) throw new Error(\`No first-party driver named \${JSON.stringify(spec)} in this ari-driver. It holds: \${Object.keys(FIRST_PARTY).join(", ")}\`);
  return pickDriver(module, \`The first-party driver module ari/drivers/\${spec}\`, { ...options, name: spec });
}

process.exit(await runAriDriver(process.argv.slice(2), { loadDriver: loadBundledDriver }));
`;
}

/** The target this machine runs, when it is one of the five. */
export function hostTarget(): BinaryTarget | undefined {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const candidate = `${os}-${process.arch}`;
  return (BINARY_TARGETS as readonly string[]).includes(candidate) ? (candidate as BinaryTarget) : undefined;
}

export function executableName(name: string, target: BinaryTarget): string {
  return target.startsWith("windows-") ? `${name}.exe` : name;
}

/** What stays out of the bundle: every optional vendor SDK but the Claude Agent SDK, and the Claude Agent SDK's platform packages. */
function externalPackages(claudeSdk: PinnedClaudeSdk, repositoryRoot: string = root): string[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as { peerDependencies?: { [name: string]: string } };
  return [...Object.keys(pkg.peerDependencies ?? {}).filter((name) => name !== CLAUDE_SDK_PACKAGE), ...claudeSdk.platformPackages].sort();
}

/** `file` relative to the repository when it is inside it, else as it is. */
function shown(file: string): string {
  const relative = path.relative(root, file);
  return relative.startsWith("..") ? file : relative;
}

function compile(entry: string, outfile: string, target: BinaryTarget, externals: readonly string[]): void {
  const bun = process.env["BUN"] ?? "bun";
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  const args = ["build", entry, "--compile", `--target=bun-${target}`, `--outfile=${outfile}`, ...externals.map((name) => `--external=${name}`)];
  const result = spawnSync(bun, args, { cwd: root, stdio: "inherit" });
  if (result.error !== undefined) throw new Error(`could not run ${bun}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${bun} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
}

interface BuildOptions {
  readonly targets: readonly BinaryTarget[];
  readonly out: string;
  readonly fakes: boolean;
}

function parseArguments(argv: readonly string[]): BuildOptions {
  let targets: BinaryTarget[] = ["linux-x64"];
  let out = path.join(root, "build", "standalone");
  let fakes = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--fakes") fakes = true;
    else if (argument === "--out") {
      out = path.resolve(argv[index + 1] ?? "");
      index += 1;
    } else if (argument === "--target") {
      const value = argv[index + 1] ?? "";
      index += 1;
      if (value === "all") targets = [...BINARY_TARGETS];
      else if ((BINARY_TARGETS as readonly string[]).includes(value)) targets = [value as BinaryTarget];
      else throw new Error(`unknown target ${JSON.stringify(value)}; use one of ${BINARY_TARGETS.join(", ")} or all`);
    } else throw new Error(`unknown argument ${JSON.stringify(argument)}`);
  }
  return { targets, out, fakes };
}

function main(argv: readonly string[]): void {
  const options = parseArguments(argv);
  const drivers = firstPartyDrivers();
  const claudeSdk = pinnedClaudeSdk();
  fs.mkdirSync(options.out, { recursive: true });
  const work = fs.mkdtempSync(path.join(options.out, ".entry-"));
  try {
    const entry = path.join(work, "ari-driver.ts");
    fs.writeFileSync(entry, entrySource(root, drivers, claudeSdk));
    for (const target of options.targets) {
      const outfile = path.join(options.out, target, executableName("ari-driver", target));
      compile(entry, outfile, target, externalPackages(claudeSdk));
      process.stdout.write(`build-binary: ${shown(outfile)} (${target}) serves ${drivers.join(", ")}, with ${CLAUDE_SDK_PACKAGE} ${claudeSdk.version} compiled in\n`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  if (!options.fakes) return;
  const target = hostTarget();
  if (target === undefined) throw new Error(`--fakes needs a host platform among ${BINARY_TARGETS.join(", ")}; this is ${process.platform}-${process.arch}`);
  const fakes = [
    { source: "test/drivers/pi/fake-pi.ts", name: "pi" },
    { source: "test/drivers/acp/standalone-agent.ts", name: "standalone-acp-agent" },
  ];
  for (const fake of fakes) {
    const outfile = path.join(options.out, target, "fakes", executableName(fake.name, target));
    compile(path.join(root, fake.source), outfile, target, []);
    process.stdout.write(`build-binary: ${shown(outfile)} from ${fake.source}\n`);
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`build-binary failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
