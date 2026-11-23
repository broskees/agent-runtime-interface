// Validates Codex app-server frames against the vendored JSON Schema
// (vendor-schemas/codex/<commit>/codex_app_server_protocol.schemas.json,
// draft-07). The fake app-server checks every frame it sends and every frame
// the driver sends with this, so both sides speak only what the schema allows.
//
// What is checked, by frame:
// - a request: against the `ClientRequest` or `ServerRequest` union (method
//   and params together);
// - a notification: against `ClientNotification` or `ServerNotification`;
// - a result: against the response type of the request it answers (named as
//   scripts/codegen-codex.ts names it, hand-written additions included);
// - an error: against `JSONRPCErrorError`.

import * as fs from "node:fs";
import * as path from "node:path";
import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import { ADDITIONS_FILE, CODEX_SOURCE, SCHEMA_FILE } from "../../../scripts/codegen-codex.ts";

export const CODEX_SCHEMA_DIR = path.resolve(import.meta.dirname, "..", "..", "..", "vendor-schemas", "codex", CODEX_SOURCE.commit);

type JsonObject = { [key: string]: unknown };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface FrameProblem {
  readonly direction: "to_codex" | "from_codex";
  readonly frame: unknown;
  readonly message: string;
}

export class CodexFrameValidator {
  readonly #ajv: Ajv;
  readonly #validators = new Map<string, ValidateFunction>();
  readonly #responseTypes = new Map<string, string>();
  /** Each union's variant for a method, as a JSON pointer. */
  readonly #variants = new Map<string, string>();
  /** Every frame checked, and every problem found. */
  checked = 0;
  readonly problems: FrameProblem[] = [];

  constructor(schemaDir = CODEX_SCHEMA_DIR) {
    const bundle = JSON.parse(fs.readFileSync(path.join(schemaDir, SCHEMA_FILE), "utf8")) as JsonObject;
    const additions = JSON.parse(fs.readFileSync(path.join(schemaDir, ADDITIONS_FILE), "utf8")) as { responseTypes: { [method: string]: string } };
    this.#ajv = new Ajv({ strict: false, validateFormats: false, allErrors: false });
    this.#ajv.addSchema(bundle, "codex");
    const definitions = bundle["definitions"] as JsonObject;
    const v2 = definitions["v2"] as JsonObject;
    for (const union of ["ClientRequest", "ServerRequest", "ClientNotification", "ServerNotification"]) {
      (definitions[union] as { oneOf: JsonObject[] }).oneOf.forEach((variant, index) => {
        const method = ((variant["properties"] as JsonObject)["method"] as { enum?: string[] }).enum?.[0];
        if (method !== undefined) this.#variants.set(`${union} ${method}`, `#/definitions/${union}/oneOf/${index}`);
      });
    }
    for (const union of ["ClientRequest", "ServerRequest"]) {
      for (const variant of (definitions[union] as { oneOf: JsonObject[] }).oneOf) {
        const properties = variant["properties"] as JsonObject;
        const methodSchema = properties["method"] as { enum?: string[] };
        const method = methodSchema.enum?.[0];
        if (method === undefined) continue;
        const override = additions.responseTypes[method];
        if (override !== undefined) {
          this.#responseTypes.set(method, v2[override] !== undefined ? `#/definitions/v2/${override}` : `#/definitions/${override}`);
          continue;
        }
        const params = properties["params"] as JsonObject | undefined;
        let ref = typeof params?.["$ref"] === "string" ? params["$ref"] : undefined;
        if (ref === undefined && Array.isArray(params?.["anyOf"])) ref = (params["anyOf"] as JsonObject[]).find((option) => typeof option["$ref"] === "string")?.["$ref"] as string | undefined;
        if (ref === undefined || !ref.endsWith("Params")) continue;
        this.#responseTypes.set(method, `${ref.slice(0, -"Params".length)}Response`);
      }
    }
  }

  #validator(pointer: string): ValidateFunction {
    let validate = this.#validators.get(pointer);
    if (validate === undefined) {
      const found = this.#ajv.getSchema(`codex${pointer}`);
      if (found === undefined) throw new Error(`the vendored Codex schema has no ${pointer}`);
      validate = found;
      this.#validators.set(pointer, validate);
    }
    return validate;
  }

  #check(direction: FrameProblem["direction"], frame: unknown, pointer: string, value: unknown, what: string): boolean {
    this.checked += 1;
    const validate = this.#validator(pointer);
    if (validate(value)) return true;
    const detail = (validate.errors ?? [])
      .slice(0, 3)
      .map((error) => `${error.instancePath || "/"} ${error.message ?? ""}`)
      .join("; ");
    this.problems.push({ direction, frame, message: `${what} does not match ${pointer}: ${detail}` });
    return false;
  }

  /** Checks a request or notification. Returns false and records the problem when it does not validate. */
  checkCall(direction: FrameProblem["direction"], frame: unknown): boolean {
    if (!isObject(frame) || typeof frame["method"] !== "string") {
      this.problems.push({ direction, frame, message: "not a JSON-RPC call" });
      return false;
    }
    const isRequest = "id" in frame;
    const union = direction === "to_codex" ? (isRequest ? "ClientRequest" : "ClientNotification") : isRequest ? "ServerRequest" : "ServerNotification";
    const variant = this.#variants.get(`${union} ${frame["method"]}`);
    if (variant === undefined) {
      this.checked += 1;
      this.problems.push({ direction, frame, message: `${frame["method"]} is not a ${union} method` });
      return false;
    }
    // The method's own variant gives a precise message; the whole union must accept the frame too.
    const what = `${frame["method"]} ${isRequest ? "request" : "notification"}`;
    return this.#check(direction, frame, variant, frame, what) && this.#check(direction, frame, `#/definitions/${union}`, frame, what);
  }

  /** Checks a response to a request of `method`: its result against the method's response type, or its error. */
  checkResponse(direction: FrameProblem["direction"], frame: unknown, method: string): boolean {
    if (!isObject(frame) || !("id" in frame)) {
      this.problems.push({ direction, frame, message: `the answer to ${method} is not a JSON-RPC response` });
      return false;
    }
    if ("error" in frame) return this.#check(direction, frame, "#/definitions/JSONRPCErrorError", frame["error"], `the error answering ${method}`);
    const pointer = this.#responseTypes.get(method);
    if (pointer === undefined) {
      this.problems.push({ direction, frame, message: `no response type is known for ${method}` });
      return false;
    }
    return this.#check(direction, frame, pointer, frame["result"], `the result of ${method}`);
  }
}
