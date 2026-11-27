// spec/v1/methods.json lists every member of the hand-written runtime
// interfaces. The members are read from src/runtime.ts with the TypeScript
// compiler API, so a new member without a wire entry fails here.

import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, test } from "node:test";
import ts from "typescript";
import { ARI_VERSION, MethodTableSchema } from "../src/index.ts";
import { createSpecAjv, defId, readMethodTable, REPO_ROOT, resolveSpecRef } from "./helpers/spec.ts";
import type { JsonObject } from "./helpers/spec.ts";

interface Member {
  readonly optional: boolean;
}

interface InterfaceSurface {
  readonly methods: Map<string, Member>;
  readonly properties: Map<string, Member>;
}

interface MethodEntry {
  name: string;
  direction: string;
  kind: string;
  interface?: string;
  member?: string;
  optional?: boolean;
  synchronous?: boolean;
  capability?: string;
  relatesTo?: string;
  params: { $ref: string };
  result?: { $ref: string };
  version: { major: number; minor: number };
  stream?: { notification: string; item: { $ref: string }; end: string; cancel: string };
}

interface PropertyEntry {
  interface: string;
  member: string;
  method: string;
  location: "params" | "result";
  pointer: string;
}

const INTERFACES = ["Driver", "Instance", "Session", "HostServices"] as const;

function readSurfaces(): Map<string, InterfaceSurface> {
  const runtimeFile = path.join(REPO_ROOT, "src", "runtime.ts");
  const program = ts.createProgram([runtimeFile], {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true,
    strict: true,
    noEmit: true,
    types: [],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, ts.createCompilerHost({})));
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(runtimeFile)!;
  const surfaces = new Map<string, InterfaceSurface>();

  const walk = (type: ts.Type, prefix: string, parentOptional: boolean, surface: InterfaceSurface): void => {
    for (const symbol of checker.getPropertiesOfType(type)) {
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
      assert.ok(declaration, `no declaration for ${prefix}${symbol.getName()}`);
      const optional = parentOptional || (symbol.flags & ts.SymbolFlags.Optional) !== 0;
      const memberPath = `${prefix}${symbol.getName()}`;
      const memberType = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(symbol, declaration));
      if (memberType.getCallSignatures().length > 0) {
        surface.methods.set(memberPath, { optional });
      } else if (ts.isPropertySignature(declaration) && declaration.type !== undefined && ts.isTypeLiteralNode(declaration.type)) {
        walk(memberType, `${memberPath}.`, optional, surface);
      } else {
        surface.properties.set(memberPath, { optional });
      }
    }
  };

  for (const name of INTERFACES) {
    const declaration = source.statements.find(
      (statement): statement is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(statement) && statement.name.text === name,
    );
    assert.ok(declaration, `src/runtime.ts declares interface ${name}`);
    const surface: InterfaceSurface = { methods: new Map(), properties: new Map() };
    walk(checker.getTypeAtLocation(declaration.name), "", false, surface);
    surfaces.set(name, surface);
  }
  return surfaces;
}

/** Follows a JSON pointer through a schema definition, resolving $ref and allOf. */
function schemaHasPointer(ref: string, pointer: string): boolean {
  let nodes: Array<{ relPath: string; node: JsonObject }> = [resolveSpecRef(ref) as { relPath: string; node: JsonObject }];
  for (const segment of pointer.split("/").slice(1)) {
    const next: Array<{ relPath: string; node: JsonObject }> = [];
    const expand = (entry: { relPath: string; node: JsonObject }): void => {
      if (typeof entry.node.$ref === "string") expand(resolveSpecRef(entry.node.$ref, entry.relPath) as { relPath: string; node: JsonObject });
      for (const member of (entry.node.allOf as JsonObject[] | undefined) ?? []) expand({ relPath: entry.relPath, node: member });
      const child = (entry.node.properties as JsonObject | undefined)?.[segment];
      if (child !== undefined) next.push({ relPath: entry.relPath, node: child as JsonObject });
    };
    nodes.forEach(expand);
    if (next.length === 0) return false;
    nodes = next;
  }
  return true;
}

function capabilitySchemaHas(dotted: string): boolean {
  return schemaHasPointer("capabilities.schema.json#/$defs/Capabilities", `/${dotted.split(".").join("/")}`);
}

describe("methods.json", () => {
  const table = readMethodTable();
  const methods = table.methods as MethodEntry[];
  const properties = table.properties as PropertyEntry[];
  const surfaces = readSurfaces();
  const byMember = new Map(methods.filter((entry) => entry.interface !== undefined).map((entry) => [`${entry.interface}.${entry.member}`, entry]));
  const byName = new Map(methods.map((entry) => [entry.name, entry]));

  test("is valid against its format schema, by Ajv and by the generated validator", () => {
    const ajv = createSpecAjv();
    const validateTable = ajv.getSchema(defId("method-table.schema.json", "MethodTable"))!;
    assert.equal(validateTable(table), true, JSON.stringify(validateTable.errors));
    assert.equal(MethodTableSchema.is(table), true);
    assert.equal(table.ariVersion, ARI_VERSION);
  });

  test("the interfaces have the inventory's member counts", () => {
    assert.equal(surfaces.get("Session")!.methods.size, 28);
    assert.equal(surfaces.get("Instance")!.methods.size, 31);
    assert.equal(surfaces.get("HostServices")!.methods.size, 17);
    assert.deepEqual([...surfaces.get("Driver")!.methods.keys()].sort(), ["create", "defaultConfig"]);
  });

  test("every interface method has an entry with matching optionality, and every entry names a real method", () => {
    for (const name of INTERFACES) {
      for (const [member, info] of surfaces.get(name)!.methods) {
        const entry = byMember.get(`${name}.${member}`);
        assert.ok(entry, `methods.json lacks ${name}.${member}`);
        assert.equal(entry.optional ?? false, info.optional, `${name}.${member} optionality`);
      }
    }
    for (const [key, entry] of byMember) {
      assert.ok(surfaces.get(entry.interface!)?.methods.has(entry.member!), `${entry.name} names ${key}, which is not a method`);
    }
    assert.equal(byMember.size, 28 + 31 + 17 + 2);
  });

  test("initialize and the event notification are listed", () => {
    assert.equal(byName.get("initialize")?.kind, "request");
    assert.equal(byName.get("initialize")?.direction, "host_to_driver");
    assert.equal(byName.get("ari/event")?.kind, "notification");
    assert.equal(byName.get("ari/event")?.direction, "driver_to_host");
  });

  test("every entry gives a direction and params and result references that resolve into spec/v1", () => {
    for (const entry of methods) {
      assert.ok(["host_to_driver", "driver_to_host", "both"].includes(entry.direction), entry.name);
      assert.doesNotThrow(() => resolveSpecRef(entry.params.$ref), `${entry.name} params ${entry.params.$ref}`);
      if (entry.kind === "request") {
        assert.ok(entry.result, `${entry.name} is a request and needs a result`);
        assert.doesNotThrow(() => resolveSpecRef(entry.result!.$ref), `${entry.name} result ${entry.result!.$ref}`);
      } else {
        assert.equal(entry.result, undefined, `${entry.name} is a notification and has no result`);
      }
      if (entry.interface === "HostServices") assert.equal(entry.direction, "driver_to_host", entry.name);
      if (entry.interface === "Session" || entry.interface === "Instance" || entry.interface === "Driver") {
        assert.equal(entry.direction, "host_to_driver", entry.name);
      }
    }
  });

  test("the streaming members say how they stream", () => {
    for (const key of ["Session.events", "Instance.statusChanges", "Instance.usageHistory.scan", "HostServices.config.get"]) {
      const stream = byMember.get(key)?.stream;
      assert.ok(stream, `${key} has a stream description`);
      assert.equal(byName.get(stream.notification)?.kind, "notification", `${key} items arrive as a notification`);
      assert.equal(byName.get(stream.end)?.kind, "notification", `${key} ends with a notification`);
      assert.equal(byName.get(stream.cancel)?.kind, "request", `${key} can be cancelled`);
      assert.doesNotThrow(() => resolveSpecRef(stream.item.$ref));
    }
    assert.equal(byMember.get("Session.events")!.stream!.notification, "ari/event");
  });

  test("every non-method member travels inside a listed method's params or result", () => {
    for (const name of INTERFACES) {
      for (const member of surfaces.get(name)!.properties.keys()) {
        const entry = properties.find((property) => property.interface === name && property.member === member);
        assert.ok(entry, `methods.json properties lacks ${name}.${member}`);
        const method = byName.get(entry.method);
        assert.ok(method, `${name}.${member} names unknown method ${entry.method}`);
        const ref = entry.location === "params" ? method.params.$ref : method.result!.$ref;
        assert.ok(schemaHasPointer(ref, entry.pointer), `${name}.${member}: ${entry.pointer} is not in ${ref}`);
      }
    }
  });

  test("capability gates name real capability paths", () => {
    const gated = methods.filter((entry) => entry.capability !== undefined);
    assert.ok(gated.length >= 15);
    for (const entry of gated) assert.ok(capabilitySchemaHas(entry.capability!), `${entry.name}: ${entry.capability}`);
  });

  test("the wire form of auth.transferSession names its target by id", () => {
    const entry = byMember.get("Instance.auth.transferSession")!;
    assert.ok(schemaHasPointer(entry.params.$ref, "/targetInstanceId"));
  });
});
