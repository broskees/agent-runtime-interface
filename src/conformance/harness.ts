// The harness interface: what a driver author gives the conformance kit.
//
// The kit drives the driver through ARI calls and owns time. The harness owns
// the native side: a fake native agent that speaks the vendor's protocol, and
// that the kit moves step by step like a puppet ("now stream this text",
// "now run a tool", "now complete the turn", "now exit the process"). The kit
// never learns how the fake is reached: over a child process's stdio, an HTTP
// server on a loopback port, or a fake SDK object handed to the driver. Only
// the harness knows, and it translates each neutral step into the vendor's
// frames. docs/conformance.md shows a harness for each of the three shapes.
//
// One run of the suite calls `workspace()` once and `setup()` once per rig.
// A rig is a fresh native side: a fresh fake agent with a fresh native store,
// so native ids start over and a scenario that compares two rigs sees the
// same native ids. Every rig of one run uses the workspace `workspace()`
// returned.

import type { HostPaths } from "../generated/host.ts";
import type { ResumeThreadInput } from "../generated/session.ts";
import type { Thread } from "../generated/thread.ts";
import type { Driver } from "../runtime.ts";
import type { FakeHostOptions } from "./fake-host.ts";

/** Directories the scenarios run in. */
export interface ConformanceWorkspace {
  /** A directory the agent works in, given as its canonical real path. */
  readonly cwd: string;
  /** A path that reaches `cwd` through a symbolic link, like macOS `/tmp`. Scenario 11 needs it. */
  readonly symlinkedCwd?: string;
  /** A second directory, for checks of forks into another directory. */
  readonly otherCwd?: string;
}

/** The sign-in state of the ambient account (the user's own provider login) as the native side reports it. */
export type AmbientAuthArrangement = "authenticated" | "unauthenticated" | "unknown" | "unavailable";

/** What the kit asks of a new rig. */
export interface RigRequest {
  /** The scenario key the rig is for, such as `settlement`. */
  readonly scenario: string;
  readonly workspace: ConformanceWorkspace;
  /**
   * How the native side answers a sign-in check for the ambient account:
   * signed in, signed out, cannot tell, or cannot answer at all (a failed or
   * timed-out check). Defaults to `authenticated`.
   */
  readonly ambientAuth: AmbientAuthArrangement;
}

/** What the kit asks of one instance's host. */
export interface InstanceArrangement {
  /**
   * True: the instance has its own managed credential that was stored but
   * never checked (for example an API key in its secrets), so its auth state
   * is `configured`. False: it relies on the ambient account.
   */
  readonly managedProfile: boolean;
}

/** One file under an instance's paths, as `listInstanceFiles` reports it. */
export interface InstanceFile {
  readonly path: string;
  readonly size: number;
  readonly modifiedMs: number;
}

/** Inputs for exercising members the driver declares supported, where the kit cannot invent them. */
export interface CapabilityExercise {
  /** A model id for `contextWindow` and `canReuseContextUsage`. Defaults to the catalog's default model. */
  readonly model?: string;
  /** An MCP app the native agent serves, for `mcpApps.*`. */
  readonly mcpApp?: {
    readonly server: string;
    readonly tool: string;
    readonly args: { readonly [key: string]: unknown };
    readonly resourceUri: string;
  };
  /** One harmless call per extension namespace the driver lists, for `ext`. */
  readonly extensionCalls?: { readonly [ns: string]: { readonly method: string; readonly params: unknown } };
}

/** A fresh native side and the driver wired to it. */
export interface HarnessRig<Config = unknown> {
  /** The driver under test, wired to this rig's fake native agent. */
  readonly driver: Driver<Config>;
  /** The instance config. Defaults to `driver.defaultConfig()`. */
  readonly config?: Config;
  /**
   * Host options for one instance: how to spawn or reach the native agent,
   * where its paths are, and the secrets the arrangement asks for. The kit
   * adds its own options for some scenarios (ambient environment, label).
   */
  hostOptions?(instanceId: string, arrangement: InstanceArrangement): FakeHostOptions<Config> | Promise<FakeHostOptions<Config>>;
  /** The puppet: the fake native agent's controls. */
  readonly native: NativeAgent;
  /**
   * Executables `probe()` may spawn, for example the CLI for `--version`.
   * Defaults to the binary of the driver's CLI manifest, if it has one.
   */
  readonly probeExecutables?: readonly string[];
  /**
   * Environment variables that carry credentials for this provider, such as
   * an API key variable. The auth scenario sets each one in the host's ambient
   * environment, the instance's `environment` and the process environment,
   * and checks that none reaches the native agent.
   */
  readonly inheritedCredentials?: readonly string[];
  /** Lists the files under an instance's paths, so the probe scenario can see writes. */
  listInstanceFiles?(paths: HostPaths): Promise<readonly InstanceFile[]>;
  readonly exercise?: CapabilityExercise;
  /** A native reference no native session has. Defaults to a strong id the kit makes up. */
  readonly missingSession?: ResumeThreadInput["native"];
  /** Stops the fake agent and frees the rig. */
  dispose?(): Promise<void>;
}

/**
 * The driver author's half of the kit. Implement it once per driver, beside
 * the fake native agent, and run it with `runConformance` or the `node:test`
 * adapter.
 */
export interface ConformanceHarness<Config = unknown> {
  /** Shown in the report. */
  readonly name: string;
  /**
   * Scenarios or checks that do not apply to this driver, each with a one-line
   * reason the report shows. Keys are scenario keys (`settlement`) or check
   * keys (`auth-states.unavailable`); docs/conformance.md lists them. A
   * scenario that a declared capability rules out needs no entry.
   */
  readonly notApplicable?: { readonly [key: string]: string };
  /**
   * `virtual` (the default): long pauses run on virtual time in this process,
   * which catches a quiet timer in a driver that runs here. `real`: the
   * scenarios wait real time, for a driver that runs in another process.
   */
  readonly time?: "virtual" | "real";
  /** The directories every rig of one run uses. Called once per run. */
  workspace(): Promise<ConformanceWorkspace>;
  /** Builds one fresh rig. */
  setup(request: RigRequest): Promise<HarnessRig<Config>>;
}

/** The fake native agent's controls. Each step resolves once the native side has done it (sent the frames). */
export interface NativeAgent {
  /** Resolves when the driver has sent the agent a new prompt, with that native turn. */
  nextTurn(): Promise<NativeTurn>;
  /**
   * Marks the native session behind `thread` as held by another process, so
   * resuming it fails the way the provider fails a locked session. Leave it
   * out when the provider has no locked state; the report then needs a reason
   * under `session-replaced.locked`.
   */
  lockSession?(thread: Thread): Promise<void>;
  /**
   * The environments the native runtime was started with, for drivers that do
   * not spawn through the host (an in-process SDK given an `env` option).
   * Spawns through the host are checked from the fake host's record.
   */
  observedEnvironments?(): Promise<ReadonlyArray<{ readonly [name: string]: string }>>;
}

/** A tool the native agent runs: its call and then its result. */
export interface NativeTool {
  readonly name: string;
  readonly input: unknown;
  readonly output: string;
  /** A workspace-relative path the tool touches. The native agent reports it as its own absolute path. */
  readonly path?: string;
}

/** An approval option, in ARI terms. The harness maps it to the vendor's option kinds and keeps `optionId` as the native id. */
export interface NativeApprovalOption {
  readonly optionId: string;
  readonly label: string;
  readonly decision: "accept" | "accept_for_session" | "accept_always" | "decline";
}

/** A native approval prompt. */
export interface NativeApproval {
  readonly kind: "command" | "file_change";
  readonly command?: readonly string[];
  readonly path?: string;
  readonly options: readonly NativeApprovalOption[];
}

/** The replies the native agent got for one approval. */
export interface NativeApprovalHandle {
  /** Resolves with the native option id of the first reply. */
  nextReply(): Promise<string>;
  /** Every native option id the agent got as a reply to this approval, in order. */
  replies(): Promise<readonly string[]>;
}

/** How the native agent fails a turn. */
export type NativeFailure =
  | { readonly kind: "provider_error"; readonly message: string }
  | { readonly kind: "usage_limit"; readonly message: string; readonly resetAt: string };

/** One native turn the driver started. */
export interface NativeTurn {
  /** The prompt text the agent received. */
  readonly prompt: string;
  /** Streams assistant text, in chunks if the protocol streams, and ends the message. */
  say(text: string): Promise<void>;
  /** Runs a tool: its call, then its result. */
  runTool(tool: NativeTool): Promise<void>;
  /** Asks for an approval. Resolves once the prompt is sent; replies arrive on the handle. */
  requestApproval(approval: NativeApproval): Promise<NativeApprovalHandle>;
  /** Starts background work that outlives the foreground turn. Needed when the driver declares `background.*`. */
  startBackgroundTask?(task: { readonly title: string }): Promise<void>;
  /** Spawns a native subagent. Needed when the driver declares `subagents.stop`. */
  spawnSubagent?(subagent: { readonly name: string }): Promise<void>;
  /** Resolves with the text of the next steer message for this turn. Needed when the driver declares `turns.steer`. */
  nextSteer?(): Promise<string>;
  /** Completes the turn: the provider's authoritative completion. */
  complete(): Promise<void>;
  /** Fails the turn the way the provider reports that failure. */
  fail(failure: NativeFailure): Promise<void>;
  /** Resolves when the driver asked the agent to stop this turn (`cancel`) or ended the agent's process to do so (`exit`). */
  stopRequested(): Promise<"cancel" | "exit">;
  /** Acknowledges a cancel: the agent reports the turn stopped. */
  finishCancelled(): Promise<void>;
  /** The native agent's process exits in the middle of this turn. */
  exitProcess(): Promise<void>;
}
