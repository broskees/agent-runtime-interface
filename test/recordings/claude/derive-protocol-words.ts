// Derives the Claude protocol words from the pinned SDK's declarations
// (`@anthropic-ai/claude-agent-sdk`'s sdk.d.ts and the `@anthropic-ai/sdk`
// types it imports), by place (../protocol-places.ts): for every spot of an
// inbound frame the SDK's types describe, the string literals they allow as
// each key's value there. An SDK message's `type` gets `user`, `assistant`,
// `system`, ...; its `message.role` gets `user`, `assistant`; and so on.
// ./protocol-words.ts holds the result, and
// test/recordings/protocol-words.test.ts checks it still equals this
// derivation.
//
// The roots are the fields of an inbound Claude frame (./frames.ts) and the
// types they carry:
//   - `message` (a `message` frame): SDKMessage;
//   - `value` (a `result` frame): the awaited return type of each Query
//     method and SDK function the driver calls (CLAUDE_QUERY_CALLS,
//     CLAUDE_MODULE_CALLS);
//   - `options` (a `can_use_tool` frame): the options CanUseTool receives (its
//     third parameter).
// A `can_use_tool` frame's `toolName` and `input` are a string and a
// `Record<string, unknown>` in the SDK's types: no protocol words there. The
// walk follows every property, union member, array element and string index
// signature from the roots, and stops at `unknown`.
//
// Usage: node test/recordings/claude/derive-protocol-words.ts   (prints the words as JSON)

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { placeProtocolWords } from "../protocol-places.ts";
import type { ProtocolWords } from "../protocol-places.ts";
import { typeScriptGraph } from "../typescript-places.ts";
import { CLAUDE_MODULE_CALLS, CLAUDE_QUERY_CALLS } from "./frames.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The pinned SDK's declaration file. */
export const CLAUDE_SDK_DECLARATIONS = path.join(REPO_ROOT, "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.d.ts");

/** The words the pinned types allow, by place. */
export function deriveClaudeProtocolWords(declarations = CLAUDE_SDK_DECLARATIONS): ProtocolWords {
  const program = ts.createProgram([declarations], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(declarations);
  if (source === undefined) throw new Error(`cannot read ${declarations}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) throw new Error(`${declarations} is not a module`);
  const exported = new Map(checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.name, symbol]));
  const declared = (name: string): ts.Type => {
    const symbol = exported.get(name);
    if (symbol === undefined) throw new Error(`${declarations} exports no ${name}`);
    return checker.getDeclaredTypeOfSymbol((symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol);
  };
  const typeOf = (symbol: ts.Symbol): ts.Type => checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration ?? symbol.declarations![0]!);

  const results: ts.Type[] = [];
  const query = declared("Query");
  for (const method of CLAUDE_QUERY_CALLS) {
    const member = query.getProperty(method);
    if (member === undefined) throw new Error(`Query has no ${method}`);
    for (const signature of typeOf(member).getCallSignatures()) results.push(checker.getAwaitedType(signature.getReturnType()) ?? signature.getReturnType());
  }
  for (const name of CLAUDE_MODULE_CALLS) {
    const symbol = exported.get(name);
    if (symbol === undefined) throw new Error(`${declarations} exports no function ${name}`);
    for (const signature of typeOf(symbol).getCallSignatures()) results.push(checker.getAwaitedType(signature.getReturnType()) ?? signature.getReturnType());
  }
  const canUseTool = declared("CanUseTool").getCallSignatures()[0];
  if (canUseTool === undefined || canUseTool.getParameters().length < 3) throw new Error("CanUseTool takes no options parameter");
  return placeProtocolWords({ message: [declared("SDKMessage")], value: results, options: [typeOf(canUseTool.getParameters()[2]!)] }, typeScriptGraph(checker));
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(deriveClaudeProtocolWords(), null, 2)}\n`);
}
