// Runs the test suite under Bun: `pnpm run test:bun`.
//
// It runs the files `pnpm run test` gives `node --test` (every
// test/**/*.test.ts), each in its own `bun test` process, the way `node --test`
// runs each file in its own Node process, and fails when any file fails.
// One `bun test` process for several files is not the same: Bun 1.3.14 shares
// one process (or, with --isolate and --parallel, one module loader) between
// them, which breaks modules with a top-level await, such as the one that
// loads `effect` for ari/effect, and lets a failed test leave Bun's node:test
// layer inside that test for the files after it.
//
// A file is left out only when test/bun-excluded.txt lists it, one line per
// file with the Node-only feature it needs. The run fails on a listed file
// that does not exist or a line that names no feature.
//
// Bun's default timeout is 5 seconds per test; `node --test` has none. Some
// tests here take minutes (a conformance suite over the wire in real time, an
// npm install of the packed package), so each test gets TEST_TIMEOUT_MS.
//
// Usage: node scripts/test-bun.ts

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The committed list of test files the Bun run leaves out, relative to the repository root. */
export const EXCLUSION_LIST = "test/bun-excluded.txt";

const TEST_TIMEOUT_MS = 600_000;

export interface Exclusion {
  /** The test file, relative to the repository root, with forward slashes. */
  readonly file: string;
  /** The Node-only feature the file needs. */
  readonly feature: string;
}

/** The files `node --test "test/**\/*.test.ts"` runs, relative to `root`, with forward slashes, sorted. */
export function testFiles(root: string): string[] {
  return fs
    .readdirSync(path.join(root, "test"), { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".test.ts"))
    .map((entry) => `test/${entry.split(path.sep).join("/")}`)
    .sort();
}

/**
 * Parses the exclusion list: one `<file>: <Node-only feature>` per line;
 * blank lines and lines starting with `#` are ignored. Throws, naming the line,
 * for a file that is not one of `files`, a missing feature or a repeated file.
 */
export function parseExclusions(text: string, files: readonly string[]): Exclusion[] {
  const known = new Set(files);
  const exclusions: Exclusion[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const where = `${EXCLUSION_LIST} line ${index + 1}`;
    const colon = line.indexOf(": ");
    if (colon === -1) throw new Error(`${where}: write "<test file>: <the Node-only feature it needs>"`);
    const file = line.slice(0, colon).trim();
    const feature = line.slice(colon + 2).trim();
    if (!known.has(file)) throw new Error(`${where}: ${file} is not a test file the suite runs`);
    if (feature === "") throw new Error(`${where}: name the Node-only feature ${file} needs`);
    if (exclusions.some((exclusion) => exclusion.file === file)) throw new Error(`${where}: ${file} is listed twice`);
    exclusions.push({ file, feature });
  }
  return exclusions;
}

interface FileResult {
  readonly file: string;
  readonly passed: boolean;
  readonly output: string;
  readonly counts: { readonly pass: number; readonly fail: number; readonly errors: number };
}

/** A count from the summary `bun test` prints at the end, such as " 51 pass". */
function summaryCount(output: string, label: string): number {
  const match = new RegExp(`^\\s*(\\d+) ${label}$`, "m").exec(output);
  return match === null ? 0 : Number(match[1]);
}

function runFile(root: string, file: string): Promise<FileResult> {
  return new Promise((resolve) => {
    const child = spawn("bun", ["test", `--timeout=${TEST_TIMEOUT_MS}`, `./${file}`], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    const finish = (passed: boolean, extra = ""): void => {
      output += extra;
      resolve({
        file,
        passed,
        output,
        counts: { pass: summaryCount(output, "pass"), fail: summaryCount(output, "fail"), errors: summaryCount(output, "errors?") },
      });
    };
    child.on("error", (error) => finish(false, `\ncould not start bun: ${error.message}\n`));
    child.on("close", (code, signal) => finish(code === 0, code === 0 ? "" : `\nbun test exited with ${signal ?? `code ${code}`}\n`));
  });
}

async function main(): Promise<number> {
  const files = testFiles(REPO_ROOT);
  const exclusions = parseExclusions(fs.readFileSync(path.join(REPO_ROOT, EXCLUSION_LIST), "utf8"), files);
  const excluded = new Set(exclusions.map((exclusion) => exclusion.file));
  const queue = files.filter((file) => !excluded.has(file));
  // As many files at once as `node --test` runs by default.
  const workers = Math.max(1, os.availableParallelism() - 1);
  const results: FileResult[] = [];
  const work = async (): Promise<void> => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      const result = await runFile(REPO_ROOT, file);
      results.push(result);
      const { pass, fail, errors } = result.counts;
      if (result.passed) {
        process.stdout.write(`ok ${file} (${pass} pass)\n`);
      } else {
        process.stdout.write(`not ok ${file} (${pass} pass, ${fail} fail, ${errors} errors)\n${result.output}\n`);
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, work));
  const failed = results.filter((result) => !result.passed);
  const total = (key: keyof FileResult["counts"]): number => results.reduce((sum, result) => sum + result.counts[key], 0);
  process.stdout.write(
    `\nbun test: ${results.length} files, ${total("pass")} tests passed, ${total("fail")} failed, ${total("errors")} errors outside tests; ` +
      `${failed.length} files failed. ${exclusions.length} files left out (${EXCLUSION_LIST}):\n`,
  );
  for (const exclusion of exclusions) process.stdout.write(`  ${exclusion.file}: ${exclusion.feature}\n`);
  for (const result of failed) process.stdout.write(`failed: ${result.file}\n`);
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
