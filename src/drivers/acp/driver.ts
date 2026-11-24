// The ACP base driver and the factory its flavors use. A flavor is thin: it
// says how to launch its agent, how to read its version, and which few
// capabilities or members differ; everything ACP is shared here.

import * as fs from "node:fs/promises";
import { AriError, callErrors } from "../../errors.ts";
import { deriveId } from "../../driver-kit/ids.ts";
import type { Capabilities } from "../../generated/capabilities.ts";
import type { ConfigValues, JsonSchema } from "../../generated/common.ts";
import type { ConfigOption, RuntimePolicy } from "../../generated/config.ts";
import type { CliLaunchManifest, DriverMetadata } from "../../generated/driver.ts";
import type { CallError } from "../../generated/errors.ts";
import type { InstanceStatus, ModelCatalog, OpenSessionInput, ProbeResult, UpdateAdvisory } from "../../generated/instance.ts";
import type { CreateInstanceRequest, Driver, HostServices, Instance, Session } from "../../runtime.ts";
import { ARI_VERSION } from "../../version.ts";
import { ACP_TESTED_PROTOCOL_RANGE, ACP_TESTED_PROTOCOL_VERSIONS, ACP_TESTED_SCHEMA_RELEASE } from "../../meta/acp.ts";
import type { AcpBaseConfig } from "../../meta/acp.ts";
import type { AcpLaunch } from "./connection.ts";
import { AcpSession } from "./session.ts";
import { ACP_IDENTITY_VERSION } from "./capabilities.ts";

/** What a flavor sees of one instance. */
export interface AcpFlavorContext<Config> {
  readonly host: HostServices<Config>;
  readonly config: Config;
  readonly instanceId: string;
  /** Environment variables the host chose for this instance. */
  readonly environment: { readonly [name: string]: string };
}

/** What `probe()` checks: an executable to find and ask for its version, or a known result that needs no process. */
export type AcpProbeTarget =
  | { readonly kind: "command"; readonly command: string; readonly versionArgs: readonly string[]; readonly env?: { readonly [name: string]: string } }
  | { readonly kind: "known"; readonly installed: boolean; readonly version?: string; readonly error?: CallError }
  | { readonly kind: "unset"; readonly message: string };

/** A semver range `>= min` and `< below`. */
export interface TestedRange {
  readonly min: string;
  readonly below: string;
}

export interface AcpFlavor<Config extends AcpBaseConfig> {
  readonly kind: string;
  readonly metadata: DriverMetadata;
  readonly configSchema: JsonSchema;
  defaultConfig(): Config;
  readonly cliManifest?: CliLaunchManifest;
  /**
   * The vendor releases the driver is tested against, for a flavor with a fixed vendor CLI. `status()` gives an
   * advisory outside them. Every ACP driver is also tested against ACP protocol versions 1 and 2, which `status()`
   * checks for all of them.
   */
  readonly testedRange?: TestedRange;
  /** The flavor's own advisory for the version `probe()` found, checked after the protocol and `testedRange`. */
  advisory?(context: AcpFlavorContext<Config>, version: string | undefined): UpdateAdvisory | undefined;
  /** Identifies the account and launch, for `continuationKey` and `bindingKey`. Never secret. */
  launchIdentity(config: Config): string;
  /** What `probe()` looks at. It must not install, write or start anything but the version command. */
  probeTarget(context: AcpFlavorContext<Config>): Promise<AcpProbeTarget>;
  /** Checks run before a session starts, for example the host's environment rules. */
  beforeSession?(context: AcpFlavorContext<Config>): Promise<void>;
  /** The command for one agent process of a session. */
  launch(context: AcpFlavorContext<Config>, input: OpenSessionInput): Promise<AcpLaunch>;
  adjustCapabilities?(capabilities: Capabilities, config: Config): Capabilities;
  /** Config values the agent should get for a runtime policy, for agents that enforce a mode through a config option. */
  policyConfig?(policy: RuntimePolicy, config: Config): ConfigValues;
  /** Adds or replaces session members the flavor handles differently. */
  decorateSession?(session: AcpSession, context: AcpFlavorContext<Config>): Session;
  /** Adds instance members the flavor has, such as `subProviders`. */
  decorateInstance?(instance: Instance, context: AcpFlavorContext<Config>): void;
}

/** The directory's real path, so a workspace reached through a symbolic link gives the same thread; the path as given when it cannot be read. */
export async function canonicalDirectory(directory: string): Promise<string> {
  try {
    return await fs.realpath(directory);
  } catch {
    return directory;
  }
}

/** The first version number in a version command's output. */
export function parseVersion(output: string): string | undefined {
  return /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(output)?.[1];
}

function versionParts(version: string): number[] {
  return version
    .split(/[-+]/)[0]!
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isNaN(part) ? 0 : part));
}

/** Compares two dotted versions by their numeric parts. */
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function inTestedRange(version: string, range: TestedRange): boolean {
  return compareVersions(version, range.min) >= 0 && compareVersions(version, range.below) < 0;
}

export function rangeText(range: TestedRange): string {
  return `>=${range.min} <${range.below}`;
}

/** Runs `command <args>` to completion as a probe, and returns its exit code and output. */
async function runProbe(host: HostServices<unknown>, command: string, args: readonly string[], env: { readonly [name: string]: string } | undefined): Promise<{ code: number | null; output: string }> {
  const child = await host.process.spawn({ command, args: [...args], purpose: "probe", stdin: "ignore", timeoutMs: 10_000, ...(env === undefined ? {} : { env: { ...env } }) });
  const decoder = new TextDecoder();
  let output = "";
  const drain = async (stream: AsyncIterable<Uint8Array>): Promise<void> => {
    for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
  };
  await Promise.all([drain(child.stdout), drain(child.stderr)]);
  const exit = await child.exited;
  return { code: exit.code, output };
}

class AcpInstance<Config extends AcpBaseConfig> implements Instance {
  readonly id: string;
  readonly continuationKey: string;
  readonly bindingKey: string;
  readonly #flavor: AcpFlavor<Config>;
  readonly #context: AcpFlavorContext<Config>;
  readonly #sessions = new Set<Session>();
  #sessionCount = 0;
  /** The agent's model option from the latest session, which is all ACP says about models. */
  #modelOption: ConfigOption | undefined;
  /** The protocol version the agent answered `initialize` with, in the latest session that started an agent. */
  #answeredProtocol: unknown;

  constructor(flavor: AcpFlavor<Config>, context: AcpFlavorContext<Config>) {
    this.#flavor = flavor;
    this.#context = context;
    this.id = context.instanceId;
    const identity = flavor.launchIdentity(context.config);
    this.continuationKey = `${flavor.kind}:${identity}`;
    this.bindingKey = `${flavor.kind}:${identity}:v${context.config.maxProtocolVersion}`;
  }

  catalog = {
    list: async (): Promise<ModelCatalog> => {
      const option = this.#modelOption;
      if (option === undefined) return { models: [] };
      const models = (option.values ?? []).map((value) => ({ id: value.id, label: value.label, ...(value.description === undefined ? {} : { description: value.description }) }));
      return { models, ...(typeof option.current === "string" ? { defaultModelId: option.current } : {}) };
    },
  };

  async status(): Promise<InstanceStatus> {
    const probe = await this.probe();
    if (!probe.installed) {
      return { state: probe.error?.code === "driver_unavailable" ? "unavailable" : "setup_required", installed: false, ...(probe.error === undefined ? {} : { error: probe.error }) };
    }
    const advisory = this.#advisory(probe.version);
    return { state: "ready", installed: true, ...(probe.version === undefined ? {} : { version: probe.version }), ...(advisory === undefined ? {} : { advisory }) };
  }

  async *statusChanges(): AsyncGenerator<InstanceStatus, void, undefined> {
    yield await this.status();
  }

  #advisory(version: string | undefined): UpdateAdvisory | undefined {
    const answered = this.#answeredProtocol;
    if (answered !== undefined && !ACP_TESTED_PROTOCOL_VERSIONS.includes(answered as number)) {
      return {
        kind: "untested_version",
        message: `The ${this.#flavor.metadata.displayName} agent answered ACP protocol version ${String(answered)}; this driver is tested against ACP protocol versions 1 and 2 (${ACP_TESTED_SCHEMA_RELEASE}) and cannot start a session with it`,
        currentVersion: String(answered),
        testedRange: ACP_TESTED_PROTOCOL_RANGE,
      };
    }
    const range = this.#flavor.testedRange;
    if (range !== undefined && version !== undefined && !inTestedRange(version, range)) {
      return {
        kind: "untested_version",
        message: `${this.#flavor.metadata.displayName} ${version} is outside the versions this driver is tested against (${rangeText(range)})`,
        currentVersion: version,
        testedRange: rangeText(range),
      };
    }
    return this.#flavor.advisory?.(this.#context, version);
  }

  /** Finds the agent and asks it for its version. Nothing else: no install, no session, no file. */
  async probe(): Promise<ProbeResult> {
    const checkedAt = new Date().toISOString();
    const target = await this.#flavor.probeTarget(this.#context);
    if (target.kind === "unset") return { ok: false, installed: false, error: callErrors.invalidState("setup_required", target.message).callError, checkedAt };
    if (target.kind === "known") {
      return { ok: target.installed, installed: target.installed, ...(target.version === undefined ? {} : { version: target.version }), ...(target.error === undefined ? {} : { error: target.error }), checkedAt };
    }
    const path = await this.#context.host.process.resolveExecutable(target.command);
    if (path === null) {
      return { ok: false, installed: false, error: callErrors.driverUnavailable({ binary: target.command }, `${target.command} is not installed or not on PATH`).callError, checkedAt };
    }
    try {
      const run = await runProbe(this.#context.host as HostServices<unknown>, target.command, target.versionArgs, target.env);
      const version = parseVersion(run.output);
      return { ok: run.code === 0, installed: true, ...(version === undefined ? {} : { version }), checkedAt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, installed: true, error: callErrors.protocol("version_check_failed", `${target.command} did not report its version: ${message}`).callError, checkedAt };
    }
  }

  async openSession(input: OpenSessionInput): Promise<Session> {
    const target = await this.#flavor.probeTarget(this.#context);
    if (target.kind === "unset") throw callErrors.invalidState("setup_required", target.message);
    if (target.kind === "command" && (await this.#context.host.process.resolveExecutable(target.command)) === null) {
      throw callErrors.driverUnavailable({ binary: target.command }, `${target.command} is not installed or not on PATH`);
    }
    if (target.kind === "known" && !target.installed && target.error !== undefined) throw new AriError(target.error);
    await this.#flavor.beforeSession?.(this.#context);
    this.#sessionCount += 1;
    const id = deriveId({ kind: "session", native: { id: null, strength: "none", ordinal: this.#sessionCount }, identityVersion: ACP_IDENTITY_VERSION, scope: this.id });
    const config = this.#context.config;
    const adjust = this.#flavor.adjustCapabilities?.bind(this.#flavor);
    const policyConfig = this.#flavor.policyConfig?.bind(this.#flavor);
    const session = new AcpSession(
      this.#context.host as HostServices<unknown>,
      {
        maxProtocolVersion: config.maxProtocolVersion,
        forkAcrossDirectories: config.forkAcrossDirectories,
        configDependencies: config.configDependencies,
        launch: () => this.#flavor.launch(this.#context, input),
        canonicalPath: canonicalDirectory,
        onProtocolAnswer: (protocolVersion) => {
          this.#answeredProtocol = protocolVersion;
        },
        onConfigOptions: (options) => {
          const model = options.find((option) => option.category === "model");
          if (model !== undefined) this.#modelOption = model;
        },
        ...(adjust === undefined ? {} : { adjustCapabilities: (capabilities: Capabilities) => adjust(capabilities, config) }),
        ...(policyConfig === undefined ? {} : { policyConfig: (policy: RuntimePolicy) => policyConfig(policy, config) }),
      },
      input,
      id,
    );
    await session.open();
    const decorated = this.#flavor.decorateSession?.(session, this.#context) ?? session;
    this.#sessions.add(decorated);
    return decorated;
  }

  async dispose(): Promise<void> {
    for (const session of this.#sessions) await session.close();
    this.#sessions.clear();
  }
}

/** A driver for one ACP flavor. */
export function createAcpDriver<Config extends AcpBaseConfig>(flavor: AcpFlavor<Config>): Driver<Config> {
  return {
    kind: flavor.kind,
    ariVersion: ARI_VERSION,
    metadata: flavor.metadata,
    configSchema: flavor.configSchema,
    defaultConfig: () => flavor.defaultConfig(),
    ...(flavor.cliManifest === undefined ? {} : { cliManifest: flavor.cliManifest }),
    async create(host: HostServices<Config>, input: CreateInstanceRequest<Config>): Promise<Instance> {
      const context: AcpFlavorContext<Config> = { host, config: input.config, instanceId: input.instanceId, environment: input.environment };
      const instance = new AcpInstance(flavor, context);
      flavor.decorateInstance?.(instance, context);
      return instance;
    },
  };
}
