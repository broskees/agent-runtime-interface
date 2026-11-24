// Checks HTTP traffic against a vendored OpenCode OpenAPI 3.1 document: the
// operation a request names, its path, query and body parameters, and the
// response body for its status. The fake servers run every request they get
// and every response they send through this, so a frame that does not match
// the pinned server's own description is a recorded violation.
//
// OpenAPI 3.1 schemas are JSON Schema 2020-12; Ajv reads the whole document
// as one schema so `#/components/schemas/...` references resolve. Vendor
// keywords (`x-...`, `contentMediaType`) are ignored, and string formats are
// not checked (the documents use none that matter here).

import * as fs from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";

interface Parameter {
  readonly name: string;
  readonly in: "path" | "query" | "header" | "cookie";
  readonly required?: boolean;
  readonly schema?: object;
  readonly style?: string;
}

type OpenApiDocument = { paths: { [template: string]: { [method: string]: Operation } } };

interface Operation {
  readonly operationId?: string;
  readonly parameters?: readonly Parameter[];
  readonly requestBody?: { readonly content?: { readonly [type: string]: { readonly schema?: object } }; readonly required?: boolean };
  readonly responses?: { readonly [status: string]: { readonly content?: { readonly [type: string]: { readonly schema?: object } } } };
}

export interface MatchedOperation {
  readonly method: string;
  readonly template: string;
  readonly operationId: string;
  readonly pathParams: { readonly [name: string]: string };
}

function escapePointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

export class OpenApiValidator {
  readonly #document: OpenApiDocument;
  readonly #ajv: Ajv2020;
  readonly #coercing: Ajv2020;
  readonly #compiled = new Map<string, ValidateFunction>();
  readonly #routes: Array<{ template: string; regex: RegExp; names: string[]; specificity: number }>;
  readonly id: string;

  constructor(specFile: string, id: string) {
    this.id = id;
    this.#document = JSON.parse(fs.readFileSync(specFile, "utf8")) as OpenApiDocument;
    const options = { strict: false, allErrors: true, validateFormats: false, allowUnionTypes: true } as const;
    this.#ajv = new Ajv2020(options);
    this.#coercing = new Ajv2020({ ...options, coerceTypes: true });
    this.#ajv.addSchema(this.#document, id);
    this.#coercing.addSchema(this.#document, id);
    this.#routes = Object.keys(this.#document.paths).map((template) => {
      const names: string[] = [];
      const pattern = template
        .split("/")
        .map((segment) => {
          if (segment === "*") return ".*";
          const name = /^\{(.+)\}$/.exec(segment)?.[1];
          if (name !== undefined) {
            names.push(name);
            return "([^/]+)";
          }
          return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("/");
      return { template, regex: new RegExp(`^${pattern}$`), names, specificity: template.split("/").filter((segment) => !segment.startsWith("{") && segment !== "*").length };
    });
  }

  /** The operation a method and path name, the most specific template first. */
  match(method: string, pathname: string): MatchedOperation | undefined {
    const lower = method.toLowerCase();
    const candidates = this.#routes.filter((route) => route.regex.test(pathname) && this.#document.paths[route.template]?.[lower] !== undefined).sort((a, b) => b.specificity - a.specificity);
    const route = candidates[0];
    if (route === undefined) return undefined;
    const values = route.regex.exec(pathname)!.slice(1).map((value) => decodeURIComponent(value));
    const operation = this.#document.paths[route.template]![lower]!;
    return { method: lower, template: route.template, operationId: operation.operationId ?? `${lower} ${route.template}`, pathParams: Object.fromEntries(route.names.map((name, index) => [name, values[index] ?? ""])) };
  }

  #operation(matched: MatchedOperation): Operation {
    return this.#document.paths[matched.template]![matched.method]!;
  }

  #validator(pointer: string, coercing: boolean): ValidateFunction {
    const key = `${coercing ? "c" : "s"}:${pointer}`;
    let compiled = this.#compiled.get(key);
    if (compiled === undefined) {
      compiled = (coercing ? this.#coercing : this.#ajv).compile({ $ref: `${this.id}#${pointer}` });
      this.#compiled.set(key, compiled);
    }
    return compiled;
  }

  #pointer(matched: MatchedOperation, ...rest: string[]): string {
    return ["", "paths", matched.template, matched.method, ...rest].map(escapePointer).join("/");
  }

  #check(validate: ValidateFunction, value: unknown, what: string): string[] {
    if (validate(value)) return [];
    return (validate.errors ?? []).slice(0, 5).map((error) => `${what}: ${error.instancePath || "/"} ${error.message ?? "is invalid"} ${JSON.stringify(error.params)}`);
  }

  /** Problems with a request: unknown route, bad path or query parameters, missing or invalid body. */
  checkRequest(method: string, url: URL, body: unknown, hasBody: boolean): { matched: MatchedOperation | undefined; problems: string[] } {
    const matched = this.match(method, url.pathname);
    if (matched === undefined) return { matched, problems: [`${method} ${url.pathname} is not an operation of the ${this.id} document`] };
    const operation = this.#operation(matched);
    const problems: string[] = [];
    const what = `${matched.operationId} request`;
    (operation.parameters ?? []).forEach((parameter, index) => {
      if (parameter.in === "path") {
        problems.push(...this.#check(this.#validator(this.#pointer(matched, "parameters", String(index), "schema"), true), matched.pathParams[parameter.name], `${what} path ${parameter.name}`));
        return;
      }
      if (parameter.in !== "query") return;
      let value: unknown;
      if (parameter.style === "deepObject") {
        const entries = [...url.searchParams.entries()].filter(([key]) => key.startsWith(`${parameter.name}[`));
        if (entries.length > 0) value = Object.fromEntries(entries.map(([key, entry]) => [key.slice(parameter.name.length + 1, -1), entry]));
      } else if (url.searchParams.has(parameter.name)) value = url.searchParams.get(parameter.name);
      if (value === undefined) {
        if (parameter.required === true) problems.push(`${what}: query parameter ${parameter.name} is required`);
        return;
      }
      problems.push(...this.#check(this.#validator(this.#pointer(matched, "parameters", String(index), "schema"), true), value, `${what} query ${parameter.name}`));
    });
    const known = new Set((operation.parameters ?? []).filter((parameter) => parameter.in === "query").map((parameter) => parameter.name));
    for (const key of new Set(url.searchParams.keys())) {
      const base = key.includes("[") ? key.slice(0, key.indexOf("[")) : key;
      if (!known.has(base)) problems.push(`${what}: query parameter ${key} is not in the document`);
    }
    const content = operation.requestBody?.content?.["application/json"];
    if (content === undefined) {
      if (hasBody) problems.push(`${what}: the operation takes no JSON body`);
    } else if (!hasBody) {
      if (operation.requestBody?.required === true) problems.push(`${what}: a JSON body is required`);
    } else {
      problems.push(...this.#check(this.#validator(this.#pointer(matched, "requestBody", "content", "application/json", "schema"), false), body, `${what} body`));
    }
    return { matched, problems };
  }

  /** Problems with a response: a status the operation does not declare, or a body that does not match. */
  checkResponse(matched: MatchedOperation, status: number, body: unknown, hasBody: boolean): string[] {
    const operation = this.#operation(matched);
    const declared = operation.responses?.[String(status)];
    const what = `${matched.operationId} response ${status}`;
    if (declared === undefined) return [`${what}: status ${status} is not declared`];
    const content = declared.content?.["application/json"];
    if (content === undefined) return hasBody ? [`${what}: the response declares no JSON body`] : [];
    if (!hasBody) return [`${what}: a JSON body is declared`];
    return this.#check(this.#validator(this.#pointer(matched, "responses", String(status), "content", "application/json", "schema"), false), body, what);
  }

  /** Problems with a value against a named component schema. */
  checkComponent(name: string, value: unknown): string[] {
    return this.#check(this.#validator(`/components/schemas/${escapePointer(name)}`, false), value, name);
  }
}
