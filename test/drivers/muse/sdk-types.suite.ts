// The type checks of the driver's SDK description and of the fake's frames
// against the pinned Muse SDK are real checks: sdk-types.ts (the driver's own
// SDK types against the SDK's) and fake-muse.ts (the fake, typed by the SDK's
// wire types) compile cleanly, and each planted mistake is caught: a params
// value the SDK does not accept, a result field the SDK does not have, a
// notification field of the wrong type, a connection member of the wrong
// type, and a malformed frame from the fake. `pnpm run typecheck` checks the
// same files as part of the whole program.

import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, test } from "node:test";
import ts from "typescript";
import { REPO_ROOT } from "../../helpers/spec.ts";

const HERE = path.join(REPO_ROOT, "test", "drivers", "muse");
const ROOTS = [path.join(HERE, "sdk-types.ts"), path.join(HERE, "fake-muse.ts")];
const DRIVER_SDK = path.join(REPO_ROOT, "src", "drivers", "muse", "sdk.ts");
const FAKE = path.join(HERE, "fake-muse.ts");

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

describe("muse driver: the SDK description and the fake are type-checked against @muse-code/sdk 1.4.25", () => {
  test("the driver's SDK types and the fake compile against the pinned SDK with no error", () => {
    assert.deepEqual(diagnostics(new Map()), []);
  });

  test("a params value the SDK refuses, a result field it lacks, a notification field of the wrong type, a connection member of the wrong type and a malformed fake frame are each caught", () => {
    const found = diagnostics(
      new Map([
        planted(
          DRIVER_SDK,
          ['  ifBusy?: "queue" | "steer" | "replace";\n', '  ifBusy?: "queue" | "steer" | "replace" | "later";\n'],
          ["export interface MuseTurnStartResult {\n  commandId: string;\n  turnId: string;\n  disposition: string;\n}", "export interface MuseTurnStartResult {\n  commandId: string;\n  turnId: string;\n  dispositionKind: string;\n}"],
          ["export interface MuseTurnCompleted {\n  sessionId: string;\n  turnId: string;\n  terminal: string;", "export interface MuseTurnCompleted {\n  sessionId: string;\n  turnId: string;\n  terminal: number;"],
          ["  mintCommandId(): string;\n  onServerRequest", "  mintCommandId(): number;\n  onServerRequest"],
        ),
        planted(FAKE, ['this.notify("turn/started", { sessionId: session.sessionId, turnId: run.turnId, commandId: run.commandId,', 'this.notify("turn/started", { sessionId: session.sessionId, commandId: run.commandId,']),
      ]),
    );
    const text = found.map((diagnostic) => `${diagnostic.file}: ${diagnostic.message}`).join("\n");
    assert.match(text, /test\/drivers\/muse\/sdk-types\.ts: .*refused: "turn\/start"/s);
    assert.match(text, /test\/drivers\/muse\/sdk-types\.ts: .*unreadable: "turn\/start"/s);
    assert.match(text, /test\/drivers\/muse\/sdk-types\.ts: .*unreadable: "turn\/completed"/s);
    assert.match(text, /test\/drivers\/muse\/sdk-types\.ts: .*mintCommandId/s);
    assert.match(text, /test\/drivers\/muse\/fake-muse\.ts: .*turnId/s);
  });
});
