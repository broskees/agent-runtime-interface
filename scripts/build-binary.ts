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
// The optional vendor SDKs in `peerDependencies` stay outside the bundle: a
// driver that needs one reports it missing in `status()`, as it does under
// Node when the package is not installed. Drivers whose SDK ships its own
// native binaries need those provisioned beside the executable.
//
// `--fakes` also compiles the fake native agents the end-to-end tests use,
// test/drivers/pi/fake-pi.ts as `pi` and test/drivers/acp/standalone-agent.ts
// as `standalone-acp-agent`, into `<out>/<host target>/fakes/`, so those
// tests run with no Node or Bun on PATH at all.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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

/** The entry file's source: a literal import of each driver module and a loader over them. */
export function entrySource(repositoryRoot: string, drivers: readonly string[]): string {
  const source = (relative: string): string => JSON.stringify(path.join(repositoryRoot, relative));
  const imports = drivers.map((name, index) => `import * as driver${index} from ${source(`src/drivers/${name}/index.ts`)};`);
  const table = drivers.map((name, index) => `  ${JSON.stringify(name)}: driver${index},`);
  return `// Written by scripts/build-binary.ts for one build. Do not edit.
import { runAriDriver } from ${source("src/wire/cli.ts")};
import { isModulePath, loadDriver, pickDriver } from ${source("src/wire/load-driver.ts")};
${imports.join("\n")}

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

function peerPackages(): string[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { peerDependencies?: { [name: string]: string } };
  return Object.keys(pkg.peerDependencies ?? {}).sort();
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
  fs.mkdirSync(options.out, { recursive: true });
  const work = fs.mkdtempSync(path.join(options.out, ".entry-"));
  try {
    const entry = path.join(work, "ari-driver.ts");
    fs.writeFileSync(entry, entrySource(root, drivers));
    for (const target of options.targets) {
      const outfile = path.join(options.out, target, executableName("ari-driver", target));
      compile(entry, outfile, target, peerPackages());
      process.stdout.write(`build-binary: ${shown(outfile)} (${target}) serves ${drivers.join(", ")}\n`);
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
