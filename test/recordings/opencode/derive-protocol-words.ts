// Derives the OpenCode protocol words from the pinned client's declarations
// (`@opencode/client` 2.1.2, `dist/promise/index.d.ts` and the generated types
// it exports): for every object key an OpenCode 2.x server can put in an
// inbound frame, the string literals the types allow as that key's value.
// `type` gets `user`, `assistant`, `session.text.delta`, ...; `effect` gets
// `allow`, `deny`, `ask`; and so on. ./protocol-words.ts holds the result, and
// test/recordings/protocol-words.test.ts checks it still equals this
// derivation.
//
// The roots are the types of what an inbound OpenCode frame carries:
//   - `event`: `OpenCodeEvent`, every event of `GET /api/event`;
//   - `response`: `ServerInfo` (the driver reads `GET /api/info` itself), the
//     awaited return type of each client call the driver makes (every method
//     of `V2Client` in src/drivers/opencode/sdk.ts, looked up by the same path
//     in the client), and every error body the client declares (each exported
//     type with a `_tag`).
// The walk follows every property, union member, array element and string
// index signature from there.
//
// Usage: node test/recordings/opencode/derive-protocol-words.ts   (prints the words as JSON)

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The pinned client's declaration entry. */
export const OPENCODE_CLIENT_DECLARATIONS = path.join(REPO_ROOT, "node_modules", "@opencode", "client", "dist", "promise", "index.d.ts");

/** The driver's own interface of the client calls it makes. */
export const OPENCODE_DRIVER_CLIENT = path.join(REPO_ROOT, "src", "drivers", "opencode", "sdk.ts");

function nonNullish(type: ts.Type): ts.Type[] {
  return (type.isUnion() ? type.types : [type]).filter((member) => (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0);
}

/** For each key, the sorted string literals the pinned types allow as its value; keys sorted. */
export function deriveOpencodeProtocolWords(declarations = OPENCODE_CLIENT_DECLARATIONS, driverClient = OPENCODE_DRIVER_CLIENT): { [key: string]: string[] } {
  const program = ts.createProgram([declarations, driverClient], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    allowImportingTsExtensions: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const checker = program.getTypeChecker();
  const exportsOf = (file: string): Map<string, ts.Symbol> => {
    const source = program.getSourceFile(file);
    if (source === undefined) throw new Error(`cannot read ${file}`);
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (moduleSymbol === undefined) throw new Error(`${file} is not a module`);
    return new Map(checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.name, symbol]));
  };
  const client = exportsOf(declarations);
  const declared = (exported: Map<string, ts.Symbol>, name: string, file: string): ts.Type => {
    const symbol = exported.get(name);
    if (symbol === undefined) throw new Error(`${file} exports no ${name}`);
    return checker.getDeclaredTypeOfSymbol((symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol);
  };
  const typeOf = (symbol: ts.Symbol): ts.Type => checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration ?? symbol.declarations![0]!);

  const roots: ts.Type[] = [declared(client, "OpenCodeEvent", declarations), declared(client, "ServerInfo", declarations)];

  // Every method path of the driver's V2Client, looked up in the pinned client.
  const clientType = declared(client, "OpenCodeClient", declarations);
  const calls: string[][] = [];
  const methods = (type: ts.Type, at: string[]): void => {
    for (const property of checker.getPropertiesOfType(type)) {
      const propertyType = typeOf(property);
      if (propertyType.getCallSignatures().length > 0) calls.push([...at, property.name]);
      else methods(propertyType, [...at, property.name]);
    }
  };
  methods(declared(exportsOf(driverClient), "V2Client", driverClient), []);
  if (calls.length === 0) throw new Error(`${driverClient} declares no V2Client calls`);
  for (const call of calls) {
    let type: ts.Type = clientType;
    for (const part of call) {
      const member = type.getProperty(part);
      if (member === undefined) throw new Error(`@opencode/client has no ${call.join(".")}, which the driver calls`);
      type = typeOf(member);
    }
    for (const signature of type.getCallSignatures()) roots.push(checker.getAwaitedType(signature.getReturnType()) ?? signature.getReturnType());
  }

  // Every error body the client declares: the exported types that carry a `_tag`.
  for (const [name, symbol] of client) {
    const target = (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
    if ((target.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) === 0) continue;
    const type = checker.getDeclaredTypeOfSymbol(target);
    if (type.getProperty("_tag") !== undefined && name.endsWith("Error")) roots.push(type);
  }

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
  process.stdout.write(`${JSON.stringify(deriveOpencodeProtocolWords(), null, 2)}\n`);
}
