// Derives the OpenCode protocol words from the pinned client's declarations
// (`@opencode/client` 2.1.2, `dist/promise/index.d.ts` and the generated types
// it exports), by place (../protocol-places.ts): for every spot of an inbound
// frame the client's types describe, the string literals they allow as each
// key's value there. An event's `type` gets `session.text.delta`, ...; a
// message's `role` gets `user`, `assistant`; a permission rule's `effect` gets
// `allow`, `deny`, `ask`; and so on. ./protocol-words.ts holds the result, and
// test/recordings/protocol-words.test.ts checks it still equals this
// derivation.
//
// The roots are the fields of an inbound OpenCode frame (./frames.ts) and the
// types they carry:
//   - `event` (an `event` frame): `OpenCodeEvent`, every event of
//     `GET /api/event`;
//   - `body` (a `response` frame): `ServerInfo` (the driver reads
//     `GET /api/info` itself), the awaited return type of each client call
//     the driver makes (every method of `V2Client` in
//     src/drivers/opencode/sdk.ts, looked up by the same path in the client),
//     and every error body the client declares (each exported type with a
//     `_tag`).
// The walk follows every property, union member, array element and string
// index signature from the roots, and stops at `unknown`.
//
// Usage: node test/recordings/opencode/derive-protocol-words.ts   (prints the words as JSON)

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { placeProtocolWords } from "../protocol-places.ts";
import type { ProtocolWords } from "../protocol-places.ts";
import { typeScriptGraph } from "../typescript-places.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The pinned client's declaration entry. */
export const OPENCODE_CLIENT_DECLARATIONS = path.join(REPO_ROOT, "node_modules", "@opencode", "client", "dist", "promise", "index.d.ts");

/** The driver's own interface of the client calls it makes. */
export const OPENCODE_DRIVER_CLIENT = path.join(REPO_ROOT, "src", "drivers", "opencode", "sdk.ts");

/** The words the pinned types allow, by place. */
export function deriveOpencodeProtocolWords(declarations = OPENCODE_CLIENT_DECLARATIONS, driverClient = OPENCODE_DRIVER_CLIENT): ProtocolWords {
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

  const bodies: ts.Type[] = [declared(client, "ServerInfo", declarations)];

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
    for (const signature of type.getCallSignatures()) bodies.push(checker.getAwaitedType(signature.getReturnType()) ?? signature.getReturnType());
  }

  // Every error body the client declares: the exported types that carry a `_tag`.
  for (const [name, symbol] of client) {
    const target = (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
    if ((target.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) === 0) continue;
    const type = checker.getDeclaredTypeOfSymbol(target);
    if (type.getProperty("_tag") !== undefined && name.endsWith("Error")) bodies.push(type);
  }

  return placeProtocolWords({ event: [declared(client, "OpenCodeEvent", declarations)], body: bodies }, typeScriptGraph(checker));
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(deriveOpencodeProtocolWords(), null, 2)}\n`);
}
