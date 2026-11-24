// Derives the Claude protocol words from the pinned SDK's declarations
// (`@anthropic-ai/claude-agent-sdk`'s sdk.d.ts and the `@anthropic-ai/sdk`
// types it imports): for every object key the SDK can put in an inbound frame,
// the string literals the types allow as that key's value. `type` gets
// `user`, `assistant`, `system`, ...; `role` gets `user`, `assistant`,
// `system`; and so on. ./protocol-words.ts holds the result, and
// test/recordings/protocol-words.test.ts checks it still equals this
// derivation.
//
// The roots are the types of what an inbound Claude frame carries:
//   - `message`: SDKMessage;
//   - `result`: the awaited return type of each Query method and SDK function
//     the driver calls (CLAUDE_QUERY_CALLS, CLAUDE_MODULE_CALLS);
//   - `can_use_tool`: the options CanUseTool receives (its third parameter).
// The walk follows every property, union member, array element and string
// index signature from there.
//
// Usage: node test/recordings/claude/derive-protocol-words.ts   (prints the words as JSON)

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { CLAUDE_MODULE_CALLS, CLAUDE_QUERY_CALLS } from "./frames.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The pinned SDK's declaration file. */
export const CLAUDE_SDK_DECLARATIONS = path.join(REPO_ROOT, "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.d.ts");

function nonNullish(type: ts.Type): ts.Type[] {
  return (type.isUnion() ? type.types : [type]).filter((member) => (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0);
}

/** For each key, the sorted string literals the pinned types allow as its value; keys sorted. */
export function deriveClaudeProtocolWords(declarations = CLAUDE_SDK_DECLARATIONS): { [key: string]: string[] } {
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

  const roots: ts.Type[] = [declared("SDKMessage")];
  const query = declared("Query");
  for (const method of CLAUDE_QUERY_CALLS) {
    const member = query.getProperty(method);
    if (member === undefined) throw new Error(`Query has no ${method}`);
    for (const signature of typeOf(member).getCallSignatures()) roots.push(checker.getAwaitedType(signature.getReturnType()) ?? signature.getReturnType());
  }
  for (const name of CLAUDE_MODULE_CALLS) {
    const symbol = exported.get(name);
    if (symbol === undefined) throw new Error(`${declarations} exports no function ${name}`);
    for (const signature of typeOf(symbol).getCallSignatures()) roots.push(checker.getAwaitedType(signature.getReturnType()) ?? signature.getReturnType());
  }
  const canUseTool = declared("CanUseTool").getCallSignatures()[0];
  if (canUseTool === undefined || canUseTool.getParameters().length < 3) throw new Error("CanUseTool takes no options parameter");
  roots.push(typeOf(canUseTool.getParameters()[2]!));

  const words = new Map<string, Set<string>>();
  const seen = new Set<ts.Type>();
  const visit = (type: ts.Type): void => {
    if (seen.has(type)) return;
    seen.add(type);
    if (type.isUnion() || type.isIntersection()) {
      for (const member of type.types) visit(member);
      return;
    }
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      for (const argument of checker.getTypeArguments(type as ts.TypeReference)) visit(argument);
      return;
    }
    if ((type.flags & ts.TypeFlags.Object) === 0) return;
    const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    if (index !== undefined) visit(index);
    for (const property of checker.getPropertiesOfType(type)) {
      if (property.valueDeclaration === undefined && (property.declarations ?? []).length === 0) continue;
      const propertyType = typeOf(property);
      const values = nonNullish(propertyType).flatMap((member) => (checker.isArrayType(member) ? checker.getTypeArguments(member as ts.TypeReference).flatMap(nonNullish) : [member]));
      for (const value of values) {
        if ((value.flags & ts.TypeFlags.StringLiteral) === 0) continue;
        const own = words.get(property.name) ?? new Set<string>();
        own.add((value as ts.StringLiteralType).value);
        words.set(property.name, own);
      }
      visit(propertyType);
    }
  };
  for (const root of roots) visit(root);
  const result: { [key: string]: string[] } = {};
  for (const key of [...words.keys()].sort()) result[key] = [...words.get(key)!].sort();
  return result;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(deriveClaudeProtocolWords(), null, 2)}\n`);
}
