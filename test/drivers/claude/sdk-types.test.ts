// The type checks of every frame against the pinned Claude Agent SDK are
// real checks: sdk-types.ts (the driver's own SDK types against the SDK's)
// and fake-sdk.ts (the fake, typed by the SDK) compile cleanly, and each of
// three planted mistakes is caught: a message field the driver reads that the
// SDK does not have, an option type the SDK does not accept, and a malformed
// frame from the fake. `pnpm run typecheck` checks the same files as part of
// the whole program.

import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, test } from "node:test";
import ts from "typescript";
import { REPO_ROOT } from "../../helpers/spec.ts";

const HERE = path.join(REPO_ROOT, "test", "drivers", "claude");
const ROOTS = [path.join(HERE, "sdk-types.ts"), path.join(REPO_ROOT, "test", "types", "headers-init.d.ts")];
const DRIVER_SDK = path.join(REPO_ROOT, "src", "drivers", "claude", "sdk.ts");
const FAKE = path.join(HERE, "fake-sdk.ts");

function compilerOptions(): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(path.join(REPO_ROOT, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic) => assert.fail(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")) });
  assert.ok(parsed !== undefined);
  return { ...parsed.options, noEmit: true };
}

/** Type-checks the roots, reading `replacements` instead of the files they name. */
function diagnostics(replacements: ReadonlyMap<string, string>): Array<{ file: string; message: string }> {
  const options = compilerOptions();
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  host.readFile = (fileName) => replacements.get(path.resolve(fileName)) ?? readFile(fileName);
  const program = ts.createProgram({ rootNames: ROOTS, options, host });
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
    file: diagnostic.file === undefined ? "" : path.relative(REPO_ROOT, diagnostic.file.fileName),
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  }));
}

/** The file's text with each `[from, to]` replaced, for a planted mistake. */
function planted(file: string, ...changes: Array<[from: string, to: string]>): [string, string] {
  let text = ts.sys.readFile(file);
  assert.ok(text !== undefined);
  for (const [from, to] of changes) {
    assert.ok(text.includes(from), `${file} no longer holds ${JSON.stringify(from)}`);
    text = text.replace(from, to);
  }
  return [file, text];
}

describe("claude driver: frames are type-checked against the pinned SDK", () => {
  test("the driver's SDK types and the fake compile against @anthropic-ai/claude-agent-sdk 0.3.330 with no error", () => {
    assert.deepEqual(diagnostics(new Map()), []);
  });

  test("a field the SDK lacks, an option the SDK refuses and a malformed fake frame are each caught", () => {
    const found = diagnostics(
      new Map([
        planted(DRIVER_SDK, ["  num_turns: number;\n", "  num_turnz: number;\n"], ["  permissionMode?: ClaudePermissionMode;\n  allowDangerouslySkipPermissions", "  permissionMode?: string;\n  allowDangerouslySkipPermissions"]),
        planted(FAKE, ["      num_turns: 1,\n      result: this.lastText,", "      result: this.lastText,"]),
      ]),
    );
    const text = found.map((diagnostic) => `${diagnostic.file}: ${diagnostic.message}`).join("\n");
    assert.match(text, /test\/drivers\/claude\/sdk-types\.ts: .*missingInSdk: "num_turnz"/s);
    assert.match(text, /test\/drivers\/claude\/sdk-types\.ts: Type 'SdkModule' is not assignable to type 'ClaudeSdk'/);
    assert.match(text, /test\/drivers\/claude\/fake-sdk\.ts: .*num_turns/s);
  });
});
