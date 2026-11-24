// Checks recorded ACP frames against ACP's own JSON Schemas, the files
// vendored in vendor-schemas/acp/<release>/ (draft 2020-12, checked with
// Ajv). Every request and notification is checked against the definition the
// schema marks with its method (`x-method`) and the side that handles it
// (`x-side`); every response against its request's response definition, or
// the schema's `Error`. Each connection is checked in the version it
// negotiated; the `initialize` request in the version it asked for.

import * as fs from "node:fs";
import * as path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { ACP_SCHEMA_RELEASE } from "../../../scripts/codegen-acp.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import type { RecordedFrame } from "./harness.ts";

type Side = "agent" | "client" | "protocol";
type Role = "Request" | "Response" | "Notification";

interface VersionSchemas {
  readonly validator: (name: string) => ValidateFunction;
  /** Definition names by method, the side that handles it, and role. */
  readonly definitions: Map<string, string>;
}

const loaded = new Map<number, VersionSchemas>();

/** The schema of one ACP version, compiled once. The unstable schema is the stable one plus the draft features the driver uses (fork). */
export function acpSchemas(version: 1 | 2): VersionSchemas {
  const cached = loaded.get(version);
  if (cached !== undefined) return cached;
  const file = path.join(REPO_ROOT, "vendor-schemas", "acp", ACP_SCHEMA_RELEASE, `v${version}`, "schema.unstable.json");
  const schema = JSON.parse(fs.readFileSync(file, "utf8")) as { $defs: { [name: string]: { "x-method"?: string; "x-side"?: string } } };
  const id = `https://agentclientprotocol.invalid/v${version}/schema.json`;
  const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: false });
  ajv.addSchema({ ...schema, $id: id });
  const definitions = new Map<string, string>();
  for (const [name, definition] of Object.entries(schema.$defs)) {
    const method = definition["x-method"];
    const side = definition["x-side"];
    if (method === undefined || side === undefined) continue;
    const role = (["Request", "Response", "Notification"] as const).find((suffix) => name.endsWith(suffix));
    if (role !== undefined) definitions.set(`${side} ${method} ${role}`, name);
  }
  const compiled = new Map<string, ValidateFunction>();
  const validator = (name: string): ValidateFunction => {
    let validate = compiled.get(name);
    if (validate === undefined) {
      validate = ajv.getSchema(`${id}#/$defs/${name}`);
      if (validate === undefined) throw new Error(`the ACP v${version} schema has no definition ${name}`);
      compiled.set(name, validate);
    }
    return validate;
  };
  const schemas = { validator, definitions };
  loaded.set(version, schemas);
  return schemas;
}

export interface FrameCheck {
  /** Frames checked against a schema definition. */
  readonly checked: number;
  /** Frames of ACP extension methods (`_…`), which have no schema; their JSON-RPC envelope is checked. */
  readonly extension: number;
  /** Checked frames by direction, method and role, for coverage assertions. */
  readonly seen: ReadonlySet<string>;
  /** Checked frames by protocol version, direction, method and role, such as `v2 client session/fork Request`. */
  readonly seenByVersion: ReadonlySet<string>;
  /** Every frame that broke the schema, described. */
  readonly problems: readonly string[];
}

type Json = { readonly [key: string]: unknown };

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks every recorded frame. */
export function checkFrames(frames: readonly RecordedFrame[]): FrameCheck {
  const problems: string[] = [];
  const seen = new Set<string>();
  const seenByVersion = new Set<string>();
  let checked = 0;
  let extension = 0;
  // Per connection: the negotiated version, and the method of each pending request by sender and id.
  const versions = new Map<number, 1 | 2>();
  const pending = new Map<string, { method: string; version: 1 | 2 }>();

  const check = (version: 1 | 2, side: Side, method: string, role: Role, value: unknown, where: string): void => {
    const name = acpSchemas(version).definitions.get(`${side} ${method} ${role}`);
    if (name === undefined) {
      problems.push(`${where}: ACP v${version} defines no ${role.toLowerCase()} ${method} handled by the ${side}`);
      return;
    }
    const validate = acpSchemas(version).validator(name);
    checked += 1;
    seen.add(`${where.split(" ")[0]} ${method} ${role}`);
    seenByVersion.add(`v${version} ${where.split(" ")[0]} ${method} ${role}`);
    if (!validate(value)) problems.push(`${where}: ${method} ${role.toLowerCase()} breaks v${version} ${name}: ${JSON.stringify(validate.errors?.slice(0, 3))} in ${JSON.stringify(value).slice(0, 400)}`);
  };

  for (const frame of frames) {
    const message = frame.message;
    const where = `${frame.from} frame on connection ${frame.connection}`;
    if (!isObject(message) || message["jsonrpc"] !== "2.0") {
      problems.push(`${where}: not a JSON-RPC 2.0 message: ${JSON.stringify(message).slice(0, 200)}`);
      continue;
    }
    const handledBy: Side = frame.from === "client" ? "agent" : "client";
    if (typeof message["method"] === "string") {
      const method = message["method"];
      const isRequest = "id" in message;
      if (isRequest && (typeof message["id"] !== "number" && typeof message["id"] !== "string")) problems.push(`${where}: request id ${JSON.stringify(message["id"])} is not a number or string`);
      let version = versions.get(frame.connection);
      if (method === "initialize") version = (isObject(message["params"]) && message["params"]["protocolVersion"] === 1 ? 1 : 2);
      if (version === undefined) {
        problems.push(`${where}: ${method} before initialize`);
        continue;
      }
      if (isRequest) pending.set(`${frame.connection} ${frame.from} ${String(message["id"])}`, { method, version });
      if (method.startsWith("_")) {
        extension += 1;
        continue;
      }
      const side: Side = method.startsWith("$/") ? "protocol" : handledBy;
      check(version, side, method, isRequest ? "Request" : "Notification", message["params"], where);
      continue;
    }
    // A response: pair it with the other side's request.
    const asker = frame.from === "client" ? "agent" : "client";
    const request = pending.get(`${frame.connection} ${asker} ${String(message["id"])}`);
    if (request === undefined) {
      problems.push(`${where}: response ${JSON.stringify(message["id"])} answers no request`);
      continue;
    }
    pending.delete(`${frame.connection} ${asker} ${String(message["id"])}`);
    let version = versions.get(frame.connection) ?? request.version;
    if (request.method === "initialize" && isObject(message["result"])) {
      const negotiated = message["result"]["protocolVersion"];
      if (negotiated !== 1 && negotiated !== 2) {
        // Neither schema defines another version, so its answer must match one of their InitializeResponse shapes.
        const shapes = ([1, 2] as const).filter((candidate) => acpSchemas(candidate).validator("InitializeResponse")(message["result"]));
        checked += 1;
        if (shapes.length === 0) problems.push(`${where}: an initialize answer with protocol version ${JSON.stringify(negotiated)} matches neither the v1 nor the v2 InitializeResponse`);
        versions.set(frame.connection, request.version);
        continue;
      }
      version = negotiated;
      versions.set(frame.connection, version);
    }
    if ("error" in message) {
      const validate = acpSchemas(version).validator("Error");
      checked += 1;
      if (!validate(message["error"])) problems.push(`${where}: error response breaks v${version} Error: ${JSON.stringify(validate.errors?.slice(0, 3))}`);
      continue;
    }
    if (request.method.startsWith("_")) {
      extension += 1;
      continue;
    }
    // The handler of the request is the side that answers it.
    check(version, frame.from === "agent" ? "agent" : "client", request.method, "Response", message["result"], where);
  }
  return { checked, extension, seen, seenByVersion, problems };
}
