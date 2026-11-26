// Assembles every `HostServices` member for one instance from the Node
// services of this subpath plus the pieces only the host can supply: the
// instance's config, attachments, host tools, a callback route and a
// coordination object shared by all of the host's instances.
//
// What this adds on top of the single services:
//   - paths: `<hostRoot>/instances/<safe instance id>/{state,cache,tmp}`,
//     created with mode 0700. The host root is created if missing and then
//     made canonical with the operating system's realpath, so drivers get
//     absolute paths without symbolic links or `..` that stay correct even
//     when a driver joins onto them with `path.join`;
//   - secrets: file-backed under the instance's `stateDir`; every value read
//     or written is registered with the instance's diagnostics, so it is
//     redacted from later diagnostic entries;
//   - background: unless the host supplies its own, `shouldRun` is true until
//     the services are disposed;
//   - dispose: ends every process the instance spawned, with its process group.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { EnvPolicy } from "../generated/host.ts";
import type { HostServices } from "../runtime.ts";
import type { Coordination } from "./coordination.ts";
import { createDiagnostics } from "./diagnostics.ts";
import type { DiagnosticRecord, Diagnostics } from "./diagnostics.ts";
import { createInstanceDirectories, instancePaths } from "./paths.ts";
import { createProcessService } from "./process.ts";
import type { Environment } from "./process.ts";
import { createFileSecrets } from "./secrets.ts";

export interface NodeHostServicesOptions<Config> {
  /** The host's own directory. Each instance gets separate directories under it. */
  hostRoot: string;
  instanceId: string;
  config: HostServices<Config>["config"];
  attachments: HostServices<Config>["attachments"];
  hostTools: HostServices<Config>["hostTools"];
  /** Usually a callback server from `startCallbackServer`, shared by the host's instances. */
  callbacks: HostServices<Config>["callbacks"];
  /** One object from `createCoordination`, shared by the host's instances. */
  coordination: Coordination;
  /** Receives each diagnostic record after redaction and truncation. */
  writeDiagnostic(record: DiagnosticRecord): void;
  /** Defaults to stripping nothing. */
  envPolicy?: EnvPolicy;
  /** The environment children start from. Defaults to `process.env`. */
  baseEnv?: Environment;
  /** Defaults to 64 KiB. */
  maxDiagnosticEntryBytes?: number;
  /** How long a process group gets after SIGTERM before SIGKILL. Defaults to 2000 ms. */
  killGraceMs?: number;
  background?: HostServices<Config>["background"];
  telemetry?: HostServices<Config>["telemetry"];
  ids?: HostServices<Config>["ids"];
  /** Aborting it ends every process the instance spawned. */
  signal?: AbortSignal;
}

export type NodeHostServices<Config> = HostServices<Config> & {
  readonly diagnostics: Diagnostics;
  /** Ends every process the instance spawned, with its process group, and turns `background.shouldRun` false. */
  dispose(): Promise<void>;
};

/** Canonicalizes the host root by following links before applying any `..`. */
async function canonicalHostRoot(directory: string): Promise<string> {
  if (process.platform === "win32" || !process.versions.bun) return fs.realpath(directory);

  // Bun 1.3.14 normalizes the input to realpath before following links. Give
  // it only a prefix at a time, so each parent is taken from the link's target.
  let prefix = directory.startsWith("/") ? "" : process.cwd();
  for (const component of directory.split("/")) {
    if (component === "..") prefix = path.posix.dirname(await fs.realpath(prefix || "/"));
    else if (component !== "") prefix = `${prefix === "/" ? "" : prefix}/${component}`;
  }
  return fs.realpath(prefix || "/");
}

export async function createNodeHostServices<Config>(options: NodeHostServicesOptions<Config>): Promise<NodeHostServices<Config>> {
  await fs.mkdir(options.hostRoot, { recursive: true, mode: 0o700 });
  const paths = instancePaths(await canonicalHostRoot(options.hostRoot), options.instanceId);
  await createInstanceDirectories(paths);
  const diagnostics = createDiagnostics(
    options.maxDiagnosticEntryBytes === undefined
      ? { write: options.writeDiagnostic }
      : { write: options.writeDiagnostic, maxEntryBytes: options.maxDiagnosticEntryBytes },
  );
  const fileSecrets = createFileSecrets({ stateDir: paths.stateDir });
  const processService = createProcessService({
    envPolicy: options.envPolicy ?? { stripAmbient: [] },
    ...(options.baseEnv === undefined ? {} : { baseEnv: options.baseEnv }),
    ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  let disposed = false;

  const services: NodeHostServices<Config> = {
    paths,
    config: options.config,
    secrets: {
      async get(namespace, key) {
        const value = await fileSecrets.get(namespace, key);
        if (value !== null) diagnostics.registerSecret(value);
        return value;
      },
      async set(namespace, key, value) {
        await fileSecrets.set(namespace, key, value);
        diagnostics.registerSecret(value);
      },
      delete: fileSecrets.delete,
    },
    process: {
      envPolicy: processService.envPolicy,
      spawn: processService.spawn,
      resolveExecutable: processService.resolveExecutable,
    },
    attachments: options.attachments,
    callbacks: options.callbacks,
    hostTools: options.hostTools,
    background: options.background ?? { shouldRun: async () => !disposed },
    coordination: options.coordination,
    diagnostics,
    async dispose() {
      disposed = true;
      await processService.dispose();
    },
  };
  if (options.telemetry !== undefined) services.telemetry = options.telemetry;
  if (options.ids !== undefined) services.ids = options.ids;
  return services;
}
