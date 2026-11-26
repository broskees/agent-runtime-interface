// One OpenCode instance: the user's own `opencode` (found on PATH or at a
// configured path) or an external OpenCode server. Nothing here runs at
// import time. A missing `opencode`, or a missing SDK for the server's
// generation, shows in `status()` and makes `openSession` fail with
// `driver_unavailable` naming what to install.
//
// Probes only run `opencode --version`, or read an external server's info
// (`GET /api/info` or `GET /global/health`): they start no server and write
// nothing. OpenCode keeps sign-in per model provider in its own store, so the
// instance has no ARI auth group of its own.
//
// The driver runs the `opencode` the user installed and never installs or
// updates one. A version older than its generation's minimum (1.19.6 for
// 1.x, 2.1.2 for 2.x) is `driver_unavailable` in `status()`, `openSession`
// and `catalog.list`, naming OPENCODE_UPDATE_STEP.

import { CliTooOldError } from "../../driver-kit/cli-too-old.ts";
import { callErrors, toCallError } from "../../errors.ts";
import { deriveId } from "../../driver-kit/ids.ts";
import type { CallError } from "../../generated/errors.ts";
import type { InstanceStatus, ModelCatalog, OpenSessionInput, ProbeResult, UpdateAdvisory } from "../../generated/instance.ts";
import type { HostServices, Instance, Session } from "../../runtime.ts";
import { IDENTITY_VERSION } from "./capabilities.ts";
import type { ServerShape } from "./capabilities.ts";
import { OPENCODE_V1_TESTED_VERSIONS, OPENCODE_V2_TESTED_VERSIONS } from "./config.ts";
import type { OpencodeConfig } from "./config.ts";
import { ServerPool } from "./pool.ts";
import type { Detected } from "./pool.ts";
import { loadSdk } from "./sdk.ts";
import type { OpencodeSdkLoaders } from "./sdk.ts";
import { generationOf, versionInRange } from "./server.ts";
import { OpencodeSession } from "./session.ts";

export function testedRangeFor(version: string): string | undefined {
  const generation = generationOf(version);
  return generation === 1 ? OPENCODE_V1_TESTED_VERSIONS : generation === 2 ? OPENCODE_V2_TESTED_VERSIONS : undefined;
}

export function versionAdvisory(version: string): UpdateAdvisory | undefined {
  const range = testedRangeFor(version);
  if (range !== undefined && versionInRange(version, range)) return undefined;
  return {
    kind: "untested_version",
    message: `OpenCode ${version} is outside the versions this driver is tested against (${OPENCODE_V1_TESTED_VERSIONS} for 1.x, ${OPENCODE_V2_TESTED_VERSIONS} for 2.x).`,
    currentVersion: version,
    ...(range === undefined ? {} : { testedRange: range }),
  };
}

function asCallError(error: unknown): CallError {
  return toCallError(error) ?? callErrors.transport(error instanceof Error ? error.message : String(error)).callError;
}

export class OpencodeInstance implements Instance {
  readonly id: string;
  readonly continuationKey: string;
  readonly bindingKey: string;
  readonly #host: HostServices<OpencodeConfig>;
  readonly #config: OpencodeConfig;
  readonly #loaders: OpencodeSdkLoaders;
  readonly #pool: ServerPool;
  readonly #sessions = new Set<OpencodeSession>();
  readonly #contextWindows = new Map<string, number>();
  #sessionCount = 0;

  constructor(host: HostServices<OpencodeConfig>, config: OpencodeConfig, instanceId: string, environment: { readonly [name: string]: string }, loaders: OpencodeSdkLoaders) {
    this.id = instanceId;
    this.#host = host;
    this.#config = config;
    this.#loaders = loaders;
    this.#pool = new ServerPool(host, config, environment, loaders);
    // OpenCode keeps sessions in the user's own OpenCode database, which any server of the same user reads.
    this.continuationKey = config.serverUrl === undefined || config.serverUrl === "" ? "opencode" : `opencode:${config.serverUrl}`;
    this.bindingKey = `opencode:${config.serverUrl ?? config.binary}:${config.model ?? ""}:${config.agent ?? ""}`;
  }

  async status(): Promise<InstanceStatus> {
    let detected: Detected;
    try {
      detected = await this.#pool.detect();
    } catch (error) {
      // Installed but older than the minimum: the driver will not run it.
      if (error instanceof CliTooOldError) return { state: "unavailable", installed: true, version: error.version, error: error.callError };
      const callError = asCallError(error);
      return { state: "unavailable", installed: callError.code !== "driver_unavailable" && !this.#pool.external, error: callError };
    }
    const advisory = versionAdvisory(detected.version);
    try {
      await loadSdk(detected.generation, this.#loaders);
    } catch (error) {
      // The server is there, but the SDK for its generation is not.
      return { state: "unavailable", installed: true, version: detected.version, error: asCallError(error), ...(advisory === undefined ? {} : { advisory }) };
    }
    return { state: "ready", installed: true, version: detected.version, ...(advisory === undefined ? {} : { advisory }), nativeSessions: { list: false, delete: false, archive: false } };
  }

  async *statusChanges(): AsyncGenerator<InstanceStatus, void, undefined> {
    yield await this.status();
  }

  async probe(_options?: { deep?: boolean }): Promise<ProbeResult> {
    const checkedAt = new Date().toISOString();
    try {
      const detected = await this.#pool.detect();
      return { ok: true, installed: true, version: detected.version, checkedAt };
    } catch (error) {
      if (error instanceof CliTooOldError) return { ok: false, installed: true, version: error.version, error: error.callError, checkedAt };
      const callError = asCallError(error);
      const installed = !this.#pool.external && callError.code !== "driver_unavailable";
      return { ok: false, installed, error: callError, checkedAt };
    }
  }

  catalog = {
    /** The models the server offers (1.x `config.providers`, 2.x `model.list`), from a server of the instance. */
    list: async (options?: { cwd?: string }): Promise<ModelCatalog> => {
      const detected = await this.#pool.detect();
      const shape: ServerShape = { generation: detected.generation, external: detected.external };
      const link = await this.#pool.linkFor(detected, shape, options?.cwd, 120_000);
      try {
        const listed = await link.runtime.models(options?.cwd ?? "");
        for (const model of listed.models) if (model.contextWindow !== undefined) this.#contextWindows.set(model.id, model.contextWindow);
        return { models: listed.models.map((model) => ({ id: model.id, label: model.label, ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }) })), ...(listed.defaultModel === undefined ? {} : { defaultModelId: listed.defaultModel }) };
      } finally {
        // A 1.x server started only for the catalog stops again; a shared server stays.
        if (shape.generation === 1 && !shape.external) await link.endpoint.stop();
      }
    },
  };

  async openSession(input: OpenSessionInput): Promise<Session> {
    const detected = await this.#pool.detect();
    // Fails with driver_unavailable naming the package when the SDK for this server's generation is missing.
    await loadSdk(detected.generation, this.#loaders);
    if (this.#contextWindows.size === 0) await this.catalog.list().catch(() => undefined);
    this.#sessionCount += 1;
    const id = deriveId({ kind: "session", native: { id: null, strength: "none", ordinal: this.#sessionCount }, identityVersion: IDENTITY_VERSION, scope: this.id });
    const session = new OpencodeSession(
      { host: this.#host, config: this.#config, pool: this.#pool, detected, shape: { generation: detected.generation, external: detected.external }, contextWindows: this.#contextWindows },
      input,
      id,
    );
    this.#sessions.add(session);
    return session;
  }

  async dispose(): Promise<void> {
    for (const session of this.#sessions) await session.close();
    this.#sessions.clear();
    await this.#pool.dispose();
  }
}
