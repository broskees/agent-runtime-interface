// src/validation.ts, src/ari-error.ts and the generated modules import each
// other in a cycle. That is only safe while nothing touches another module's
// top-level state during loading. Each check loads one module first, in a fresh
// process, then validates data and builds an AriError, so a load-order bug
// (a "Cannot access ... before initialization" error) fails here.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, test } from "node:test";
import { REPO_ROOT } from "./helpers/spec.ts";

const run = promisify(execFile);

function modules(directory: string, extension: string): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension) && !entry.name.endsWith(".d.ts"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

async function loadFirst(first: string, index: string): Promise<string> {
  const script = [
    `await import(${JSON.stringify(pathToFileURL(first).href)});`,
    `const ari = await import(${JSON.stringify(pathToFileURL(index).href)});`,
    "const event = { seq: 1, at: 'now', sessionId: 's', body: { type: 'notice', level: 'info', text: 'hi' } };",
    "const error = new ari.AriError({ code: 'transport', message: 'gone' });",
    "console.log(JSON.stringify([ari.AriEventSchema.is(event), ari.isCallError(JSON.parse(JSON.stringify(error)), 'transport')]));",
  ].join("\n");
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: REPO_ROOT });
  return stdout.trim();
}

describe("module load order", () => {
  test("every source module can be loaded first", async () => {
    const sources = modules(path.join(REPO_ROOT, "src"), ".ts");
    assert.ok(sources.length >= 25, `found ${sources.length} source modules`);
    const results = await Promise.all(sources.map((first) => loadFirst(first, path.join(REPO_ROOT, "src", "index.ts"))));
    results.forEach((result, index) => assert.equal(result, "[true,true]", sources[index]));
  });

  test("every built module can be loaded first", async () => {
    const dist = path.join(REPO_ROOT, "dist");
    assert.ok(fs.existsSync(path.join(dist, "index.js")), "dist/ is missing: run `pnpm run build` first (the gate does)");
    const built = modules(dist, ".js");
    const results = await Promise.all(built.map((first) => loadFirst(first, path.join(dist, "index.js"))));
    results.forEach((result, index) => assert.equal(result, "[true,true]", built[index]));
  });
});
