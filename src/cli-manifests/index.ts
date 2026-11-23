// `ari/cli-manifests`: declarative launch descriptors for hosts that offer a
// native terminal fallback (running the provider's own CLI in a terminal).
// A driver that launches a CLI exports a `CliLaunchManifest`; this module
// validates it and builds the argv and environment for a fresh, resumed or
// forked launch. Browser-safe: it spawns nothing and imports no Node built-in.
//
// Building a launch:
//
// - `args.fresh`, `args.resume` or `args.fork` gives the arguments. The
//   placeholders `{sessionId}` and `{cwd}` are replaced in every argument; a
//   launch whose arguments use `{sessionId}` needs one. A manifest without
//   `resume` or `fork` arguments cannot make that launch (`unsupported`).
// - The environment is the given base minus every variable whose name starts
//   with one of `envScrubPrefixes` (case-sensitive), plus `extraEnv`, which is
//   added after scrubbing because the host chose it explicitly.
// - MCP servers reach the CLI as the common `{ "mcpServers": { name: { type,
//   command, args, env, cwd, url, headers } } }` JSON, by the manifest's
//   `mcpInjection.mode`: `inline_json` adds `flag` and the JSON text;
//   `config_file` adds `flag` and `mcpConfigPath`, and returns the file the host
//   must write there before launching; `env` sets the variable `env` to the
//   JSON text. A launch with MCP servers and no `mcpInjection` is `unsupported`.

import { callErrors } from "../errors.ts";
import { CliLaunchManifestSchema } from "../generated/driver.ts";
import type { CliLaunchManifest } from "../generated/driver.ts";
import type { McpServerConfig } from "../generated/session.ts";

export { CliLaunchArgsSchema, CliLaunchManifestSchema, CliMcpInjectionSchema } from "../generated/driver.ts";
export type { CliLaunchArgs, CliLaunchManifest, CliMcpInjection } from "../generated/driver.ts";

export type CliLaunchKind = "fresh" | "resume" | "fork";

export interface CliLaunchRequest {
  readonly kind: CliLaunchKind;
  /** The working directory; it also fills `{cwd}`. */
  readonly cwd: string;
  /** Fills `{sessionId}`: the native session to resume or fork from. */
  readonly sessionId?: string;
  /** The base environment, for example the host's own. Variables set to `undefined` are left out. */
  readonly env: { readonly [name: string]: string | undefined };
  /** Variables added after scrubbing. */
  readonly extraEnv?: { readonly [name: string]: string };
  /** MCP servers to hand to the CLI. Their names come from the host. */
  readonly mcpServers?: readonly McpServerConfig[];
  /** Where the host will write the MCP config, for `config_file` injection. */
  readonly mcpConfigPath?: string;
}

export interface CliLaunch {
  readonly command: string;
  readonly args: string[];
  readonly env: { [name: string]: string };
  readonly cwd: string;
  /** Files the host must write before launching (the MCP config for `config_file` injection). */
  readonly files: Array<{ readonly path: string; readonly contents: string }>;
}

/** Returns `manifest` when it is a valid CLI launch manifest; otherwise throws a `validation` call error naming the bad field. */
export function validateCliManifest(manifest: unknown): CliLaunchManifest {
  return CliLaunchManifestSchema.parse(manifest);
}

/** `env` without the variables whose names start with one of `prefixes`, and without `undefined` values. */
export function scrubEnv(env: { readonly [name: string]: string | undefined }, prefixes: readonly string[]): { [name: string]: string } {
  const scrubbed: { [name: string]: string } = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (prefixes.some((prefix) => name.startsWith(prefix))) continue;
    scrubbed[name] = value;
  }
  return scrubbed;
}

/** The `{ "mcpServers": { ... } }` JSON text for `servers`, keyed by each server's host-chosen name. */
export function mcpServersJson(servers: readonly McpServerConfig[]): string {
  const mcpServers: { [name: string]: { [field: string]: unknown } } = {};
  for (const server of servers) {
    const { name, transport, ...connection } = server;
    if (Object.hasOwn(mcpServers, name)) throw callErrors.validation([{ message: `duplicate MCP server name "${name}"`, path: ["mcpServers"] }]);
    mcpServers[name] = { type: transport, ...connection };
  }
  return JSON.stringify({ mcpServers });
}

function fillPlaceholders(argument: string, request: CliLaunchRequest): string {
  if (argument.includes("{sessionId}") && request.sessionId === undefined) {
    throw callErrors.validation(
      [{ message: `a ${request.kind} launch needs a sessionId for its arguments`, path: ["sessionId"] }],
      `A ${request.kind} launch needs a sessionId`,
    );
  }
  return argument.replaceAll("{sessionId}", request.sessionId ?? "").replaceAll("{cwd}", request.cwd);
}

/**
 * Builds the command, arguments, environment and files for one launch from a
 * manifest. Throws a `validation` call error for an invalid manifest (for
 * example one missing `binary`) or a missing `sessionId`, and an `unsupported`
 * call error for a launch kind or MCP injection the manifest does not offer.
 */
export function buildCliLaunch(manifest: unknown, request: CliLaunchRequest): CliLaunch {
  const valid = validateCliManifest(manifest);
  const kindArgs = valid.args[request.kind];
  if (kindArgs === undefined) throw callErrors.unsupported(`cliManifest.args.${request.kind}`);

  const args = kindArgs.map((argument) => fillPlaceholders(argument, request));
  const env = { ...scrubEnv(request.env, valid.envScrubPrefixes ?? []), ...request.extraEnv };
  const files: Array<{ path: string; contents: string }> = [];

  const servers = request.mcpServers ?? [];
  if (servers.length > 0) {
    const injection = valid.mcpInjection;
    if (injection === undefined) throw callErrors.unsupported("cliManifest.mcpInjection");
    const json = mcpServersJson(servers);
    if (injection.mode === "env") {
      if (injection.env === undefined) {
        throw callErrors.validation([{ message: "env injection needs an env variable name", path: ["mcpInjection", "env"] }]);
      }
      env[injection.env] = json;
    } else if (injection.mode === "inline_json" || injection.mode === "config_file") {
      if (injection.flag === undefined) {
        throw callErrors.validation([{ message: `${injection.mode} injection needs a flag`, path: ["mcpInjection", "flag"] }]);
      }
      if (injection.mode === "inline_json") {
        args.push(injection.flag, json);
      } else {
        if (request.mcpConfigPath === undefined) {
          throw callErrors.validation([{ message: "config_file injection needs mcpConfigPath", path: ["mcpConfigPath"] }]);
        }
        args.push(injection.flag, request.mcpConfigPath);
        files.push({ path: request.mcpConfigPath, contents: json });
      }
    } else {
      throw callErrors.unsupported(`cliManifest.mcpInjection.mode.${injection.mode}`);
    }
  }

  return { command: valid.binary, args, env, cwd: request.cwd, files };
}
