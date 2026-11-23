// Checks recorded Pi frames, session-file lines and the bridge extension
// against the TypeScript types `@earendil-works/pi-coding-agent` publishes, at
// the version test/drivers/pi/SOURCES.md pins.
//
// Each distinct value becomes a typed constant in a TypeScript file that only
// exists in memory, and the TypeScript compiler checks that file. Object
// literals get TypeScript's excess-property check, so a field Pi's type does
// not have fails as well as a missing or mistyped one. The program skips the
// package's own declaration files (`skipLibCheck`): they do not compile under
// this repository's strict settings, and they are Pi's to check, not ours.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const VIRTUAL_DIRECTORY = path.join(ROOT, "test", "drivers", "pi");

/** Frames whose shape Pi documents but does not export as a type. */
const DOCUMENTED_EXTRAS = `
/** RPC-only event, Pi docs json.md "RPC-only events". */
type RpcExtensionErrorEvent = { type: "extension_error"; extensionPath: string; event: string; error: string };
`;

function check(files: ReadonlyMap<string, string>, options: ts.CompilerOptions): string[] {
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (name) => files.get(path.resolve(name)) ?? readFile(name);
  host.fileExists = (name) => files.has(path.resolve(name)) || fileExists(name);
  host.getSourceFile = (name, version, onError, create) => {
    const text = files.get(path.resolve(name));
    return text === undefined ? getSourceFile(name, version, onError, create) : ts.createSourceFile(name, text, version, true);
  };
  const program = ts.createProgram([...files.keys()], options, host);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    if (diagnostic.file === undefined || diagnostic.start === undefined) return message;
    const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    const lineText = diagnostic.file.text.split("\n")[line] ?? "";
    return `${path.basename(diagnostic.file.fileName)}:${line + 1}: ${message}\n    ${lineText.slice(0, 400)}`;
  });
}

/** Every line of every Pi session file (`*.jsonl`) under `root`. */
export function sessionLinesUnder(root: string): unknown[] {
  const lines: unknown[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".jsonl")) for (const line of fs.readFileSync(full, "utf8").split("\n")) if (line.trim() !== "") lines.push(JSON.parse(line));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return lines;
}

const BASE_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
  types: ["node"],
  strict: true,
  skipLibCheck: true,
  noEmit: true,
};

/** One recorded record per line, deduplicated. */
function constants(values: readonly unknown[], type: string, prefix: string): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const value of values) {
    const text = JSON.stringify(value);
    if (seen.has(text)) continue;
    seen.add(text);
    lines.push(`export const ${prefix}${lines.length}: ${type} = ${text};`);
  }
  return lines.join("\n");
}

/**
 * Type-checks what the driver sent Pi (`RpcCommand` or `RpcExtensionUIResponse`),
 * what Pi sent the driver (`RpcResponse`, `JsonAgentSessionEvent` or
 * `RpcExtensionUIRequest`), and the lines of Pi session files (`SessionHeader`
 * or `SessionEntry`). Returns the compiler's diagnostics; none means every
 * value matches Pi's types.
 */
export function checkAgainstPiTypes(input: { readonly sent: readonly unknown[]; readonly received: readonly unknown[]; readonly sessionLines: readonly unknown[] }): string[] {
  const source = [
    `import type { JsonAgentSessionEvent, RpcCommand, RpcExtensionUIRequest, RpcExtensionUIResponse, RpcResponse, SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";`,
    DOCUMENTED_EXTRAS,
    `type DriverToPi = RpcCommand | RpcExtensionUIResponse;`,
    `type PiToDriver = RpcResponse | JsonAgentSessionEvent | RpcExtensionUIRequest | RpcExtensionErrorEvent;`,
    `type SessionLine = SessionHeader | SessionEntry;`,
    constants(input.sent, "DriverToPi", "sent"),
    constants(input.received, "PiToDriver", "received"),
    constants(input.sessionLines, "SessionLine", "line"),
  ].join("\n");
  return check(new Map([[path.join(VIRTUAL_DIRECTORY, "__pi_frames__.ts"), source]]), BASE_OPTIONS);
}

/**
 * Type-checks the bridge extension's source with its `pi` parameter typed as
 * Pi's `ExtensionAPI`, so every event name, handler and result it uses must be
 * Pi's. Its own small helpers stay untyped, as Pi loads it as plain script.
 */
export function checkBridgeAgainstPiTypes(bridgeSource: string): string[] {
  const marker = "pi /*: ExtensionAPI */";
  if (!bridgeSource.includes(marker)) return [`the bridge source has no "${marker}" parameter to type`];
  const source = [`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`, bridgeSource.replace(marker, "pi: ExtensionAPI")].join("\n");
  return check(new Map([[path.join(VIRTUAL_DIRECTORY, "__pi_bridge__.ts"), source]]), { ...BASE_OPTIONS, noImplicitAny: false });
}
