// Pinned TypeScript declarations as a ProtocolGraph (./protocol-places.ts),
// for the kits whose native side is typed by a package's declarations: the
// Claude Agent SDK's sdk.d.ts and the OpenCode client's index.d.ts. A value
// is a type: its words are the string literals among its union members and
// array elements, its shapes the object types among them (an intersection is
// one shape, the properties TypeScript gives it). A shape's fields are its
// declared properties (not its symbol-keyed ones, which JSON never holds), and
// its string index signature is its type for every other key. `unknown`, `any`, type parameters and functions hold neither
// words nor shapes, so the walk stops there.

import ts from "typescript";
import type { ProtocolGraph } from "./protocol-places.ts";

function isNullish(type: ts.Type): boolean {
  return (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;
}

export function typeScriptGraph(checker: ts.TypeChecker): ProtocolGraph<ts.Type, ts.Type> {
  const typeOf = (symbol: ts.Symbol): ts.Type => checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration ?? symbol.declarations![0]!);

  /** The members of `type` a value can be: union members and array or tuple elements, at any depth, without null and undefined. */
  const members = (type: ts.Type, seen = new Set<ts.Type>()): ts.Type[] => {
    if (seen.has(type)) return [];
    seen.add(type);
    if (type.isUnion()) return type.types.flatMap((member) => members(member, seen));
    if (checker.isArrayType(type) || checker.isTupleType(type)) return checker.getTypeArguments(type as ts.TypeReference).flatMap((member) => members(member, seen));
    return isNullish(type) ? [] : [type];
  };

  /** An object type a value can be: not a primitive, not an array, not a function, not a branded primitive such as `string & {}`. */
  const isShape = (type: ts.Type): boolean => {
    if (type.isIntersection()) return type.types.every((member) => (member.flags & ts.TypeFlags.Object) !== 0);
    if ((type.flags & ts.TypeFlags.Object) === 0) return false;
    return !(type.getCallSignatures().length > 0 && checker.getPropertiesOfType(type).length === 0);
  };

  const fields = new Map<ts.Type, Map<string, ts.Type[]>>();
  return {
    words: (value) => members(value).flatMap((member) => ((member.flags & ts.TypeFlags.StringLiteral) === 0 ? [] : [(member as ts.StringLiteralType).value])),
    shapes: (value) => members(value).filter(isShape),
    fields: (shape) => {
      let own = fields.get(shape);
      if (own === undefined) {
        own = new Map();
        for (const property of checker.getPropertiesOfType(shape)) {
          if (property.valueDeclaration === undefined && (property.declarations ?? []).length === 0) continue;
          // A symbol-keyed member (`[Symbol.asyncIterator]`) never reaches JSON, and its internal name changes from program to program.
          if (String(property.escapedName).startsWith("__@")) continue;
          own.set(property.name, [typeOf(property)]);
        }
        fields.set(shape, own);
      }
      return own;
    },
    anyKey: (shape) => {
      const index = checker.getIndexTypeOfType(shape, ts.IndexKind.String);
      return index === undefined ? undefined : [index];
    },
  };
}
