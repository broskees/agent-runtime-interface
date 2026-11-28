// One Antigravity scenario through a fresh ARI Antigravity driver, the same
// way for a recording and for its replay: the same temp workspace layout, the
// same driver config, the same host and the same model choice. Only the
// process service differs: the tapped real one (starting `agy acp`, or a fake
// `agy` in tests) when recording, the replay process service when replaying.
//
// The workspace (one temp directory per scenario) holds:
//   cwd/            the thread's working directory, the root of its own Git
//                   repository (`cwd/.git`): Antigravity reads AGENTS.md,
//                   GEMINI.md and .agents/ in the folder it works in and in
//                   each parent folder up to the root of its repository, and
//                   stops there ("Customization discovery", "Workspace
//                   folders and parent directories"), so it reads none of
//                   the workspace's parents
//   agy-home/       HOME for `agy`, empty (not "home/": a path under it would
//                   read <WORKSPACE>/home/..., which the scan takes for a
//                   path starting /home/)
//   xdg-config/, xdg-data/, xdg-state/, xdg-cache/, xdg-runtime/
//                   the XDG base directories for `agy`
//   tmp/            TMPDIR for `agy`, so a temp path it reports is inside the
//                   workspace
//   instances/      the host's directories for the driver instance; the
//                   driver keeps the instance's Antigravity profile in
//                   instances/antigravity-recorder/state/profile
//
// The model: an ACP agent offers its models as a session config option of
// category `model`, and `agy acp` does ("Models and thinking level" in
// Antigravity's ACP guide). Before each turn the host gives the turn the
// model the recorder chose as that option's value; the driver sends it with
// `session/set_config_option` when the thread holds another.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFakeHost } from "../../../src/conformance/fake-host.ts";
import type { DiagnosticEntry } from "../../../src/generated/host.ts";
import type { ConfigOption } from "../../../src/generated/config.ts";
import type { StartTurnInput, StartTurnResult } from "../../../src/generated/session.ts";
import { ANTIGRAVITY_DEFAULT_CONFIG, createAntigravityDriver } from "../../../src/drivers/antigravity/index.ts";
import type { AntigravityConfig } from "../../../src/drivers/antigravity/index.ts";
import type { HostServices, Session } from "../../../src/runtime.ts";
import { runScenario } from "../scenarios.ts";
import type { NativeProgress, Scenario, ScenarioRun } from "../scenarios.ts";

export const ANTIGRAVITY_RECORDER_INSTANCE_ID = "antigravity-recorder";
export const ANTIGRAVITY_MODEL_VARIABLE = "ARI_RECORD_ANTIGRAVITY_MODEL";
export const ANTIGRAVITY_EFFORT_VARIABLE = "ARI_RECORD_ANTIGRAVITY_EFFORT";

export interface AntigravityLayout {
  readonly root: string;
  readonly cwd: string;
  readonly home: string;
  readonly configHome: string;
  readonly dataHome: string;
  readonly stateHome: string;
  readonly cacheHome: string;
  readonly runtimeDir: string;
  readonly tmp: string;
  /** The host's state directory for the instance. */
  readonly stateDir: string;
  /** The instance's Antigravity profile, `--gemini-dir` of `agy acp`: the driver's `<stateDir>/profile`. */
  readonly profile: string;
}

/** Makes `directory` the root of a Git repository of its own, with the least one holds: HEAD, objects/ and refs/, which Git looks for. */
function makeOwnRepository(directory: string): void {
  const git = path.join(directory, ".git");
  for (const each of ["objects", path.join("refs", "heads"), path.join("refs", "tags")]) fs.mkdirSync(path.join(git, each), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(git, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(git, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n");
}

/** A fresh temp workspace, by its real path, whose `cwd/` is the root of its own Git repository. */
export function createAntigravityLayout(prefix: string): AntigravityLayout {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const instance = path.join(root, "instances", ANTIGRAVITY_RECORDER_INSTANCE_ID);
  const layout: AntigravityLayout = {
    root,
    cwd: path.join(root, "cwd"),
    home: path.join(root, "agy-home"),
    configHome: path.join(root, "xdg-config"),
    dataHome: path.join(root, "xdg-data"),
    stateHome: path.join(root, "xdg-state"),
    cacheHome: path.join(root, "xdg-cache"),
    runtimeDir: path.join(root, "xdg-runtime"),
    tmp: path.join(root, "tmp"),
    stateDir: path.join(instance, "state"),
    profile: path.join(instance, "state", "profile"),
  };
  for (const directory of [layout.cwd, layout.home, layout.configHome, layout.dataHome, layout.stateHome, layout.cacheHome, layout.runtimeDir, layout.tmp, layout.stateDir, path.join(instance, "cache"), path.join(instance, "tmp")]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  makeOwnRepository(layout.cwd);
  return layout;
}

/** The driver config every recording and replay uses: the user's `agy` on PATH, with the driver's defaults. */
export function antigravityRecorderConfig(): AntigravityConfig {
  return { ...ANTIGRAVITY_DEFAULT_CONFIG };
}

/**
 * The environment rule of the recorder's host, its own choice: it keeps the
 * recording user's Google and Antigravity variables from `agy`, which signs in
 * through the recording's own profile.
 */
export const ANTIGRAVITY_RECORDER_ENV_POLICY = { stripAmbient: ["GEMINI_*", "GOOGLE_*", "GCLOUD_*", "CLOUDSDK_*", "AGY_*"] };

/** The model is missing from what the agent offers, or the agent offers none: the recorder stops before the first prompt. */
export class AntigravityModelChoiceError extends Error {
  readonly models: readonly string[];
  constructor(message: string, models: readonly string[]) {
    super(message);
    this.name = "AntigravityModelChoiceError";
    this.models = models;
  }
}

/** Picks the model from the agent's model option, once, and holds every later turn to it. */
export interface ModelChooser {
  /** The model chosen, once a turn needed one. */
  readonly chosen: string | undefined;
  /** The model for a turn, given the thread's model option; throws AntigravityModelChoiceError when it cannot pick one. */
  pick(option: ConfigOption | undefined): string | undefined;
}

function offered(option: ConfigOption): string[] {
  return (option.values ?? []).map((value) => value.id);
}

function listed(option: ConfigOption | undefined): string {
  const values = option?.values ?? [];
  return values.length === 0 ? "  (none)" : values.map((value) => `  ${value.id}${value.label === value.id ? "" : ` (${value.label})`}`).join("\n");
}

/**
 * The recorder's default: the first model the agent offers whose id or name
 * holds "flash", any case. Flash models are Antigravity's smallest Gemini
 * models (Antigravity docs, "Choose a model").
 */
export function defaultAntigravityModel(option: ConfigOption): string | undefined {
  return option.values?.find((value) => /flash/i.test(value.id) || /flash/i.test(value.label))?.id;
}

function chooser(decide: (option: ConfigOption) => string): ModelChooser {
  let chosen: string | undefined;
  return {
    get chosen() {
      return chosen;
    },
    pick(option) {
      if (option === undefined) {
        // A thread whose agent sent no model option keeps the model the session has; only the first turn needs one.
        if (chosen !== undefined) return undefined;
        throw new AntigravityModelChoiceError("the agent offers no model option (a session config option of category model), so the recorder cannot choose a model", []);
      }
      if (chosen === undefined) chosen = decide(option);
      if (!offered(option).includes(chosen)) throw new AntigravityModelChoiceError(`the agent does not offer the model ${chosen} for this thread. It offers:\n${listed(option)}`, offered(option));
      return chosen;
    },
  };
}

/** The recorder's choice: ARI_RECORD_ANTIGRAVITY_MODEL when set, else `defaultAntigravityModel`. */
export function recordingModelChooser(env: { readonly [name: string]: string | undefined }): ModelChooser {
  const named = env[ANTIGRAVITY_MODEL_VARIABLE]?.trim();
  return chooser((option) => {
    if (named !== undefined && named !== "") {
      if (!offered(option).includes(named)) throw new AntigravityModelChoiceError(`${ANTIGRAVITY_MODEL_VARIABLE} names ${named}, which the agent does not offer. It offers:\n${listed(option)}`, offered(option));
      return named;
    }
    const flash = defaultAntigravityModel(option);
    if (flash === undefined) throw new AntigravityModelChoiceError(`the agent offers no Flash model, the recorder's default. Set ${ANTIGRAVITY_MODEL_VARIABLE} to one of the models it offers:\n${listed(option)}`, offered(option));
    return flash;
  });
}

/** A replay's choice: the model the recording's header names. */
export function fixedModelChooser(model: string): ModelChooser {
  return chooser(() => model);
}

/**
 * The model option the session last announced for `threadId` (its latest
 * `config.updated`), read off every event the session emitted so far. The
 * session keeps its events, so this reads exactly those, whatever the host
 * has read of them yet.
 */
async function modelOptionOf(session: Session, threadId: string): Promise<ConfigOption | undefined> {
  const events = session.events({ fromSeq: 1 })[Symbol.asyncIterator]();
  let option: ConfigOption | undefined;
  try {
    for (;;) {
      // A kept event comes at once; when none is left, the next would wait, and the macrotask wins.
      const next = await Promise.race([events.next(), new Promise<undefined>((resolve) => setImmediate(() => resolve(undefined)))]);
      if (next === undefined || next.done === true) break;
      const body = next.value.body;
      if (next.value.threadId === threadId && body.type === "config.updated") option = body.options.find((each) => each.category === "model");
    }
  } finally {
    await events.return?.();
  }
  return option;
}

/** `session`, whose startTurn gives each turn the chosen model as the value of its thread's model option. */
export function withModelChoice(session: Session, models: ModelChooser, pin?: { model: string; thought_level: string }): Session {
  const startTurn = async (input: StartTurnInput): Promise<StartTurnResult> => {
    const option = await modelOptionOf(session, input.threadId);
    const model = models.pick(option);
    if (option === undefined || model === undefined) return session.startTurn(input);
    return session.startTurn({ ...input, config: { ...(input.config ?? {}), [option.id]: model } });
  };
  return new Proxy(session, {
    get(target, property) {
      if (property === "startTurn") return startTurn;
      // Apply and verify the two pickers as the thread opens, not after a
      // prompt. The model must be set first because it controls the efforts.
      if (pin !== undefined && (property === "createThread" || property === "resumeThread")) {
        return async (input: Parameters<Session["createThread"]>[0] & Parameters<Session["resumeThread"]>[0]) => {
          const thread = await target[property]({ ...input, config: { ...input.config, ...pin } });
          if (thread.appliedConfig?.["model"] !== pin.model || thread.appliedConfig?.["thought_level"] !== pin.thought_level) {
            throw new AntigravityModelChoiceError("the ACP thread did not confirm the requested model and effort", []);
          }
          return thread;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export interface AntigravityScenarioInput {
  readonly scenario: Scenario;
  readonly layout: AntigravityLayout;
  /** The process service the driver spawns `agy acp` through: the tapped real one, or the replay's. */
  readonly process: HostServices["process"];
  readonly models: ModelChooser;
  readonly pin?: { model: string; thought_level: string };
  readonly timeoutMs: number;
  readonly native?: NativeProgress;
  readonly mayApprove?: NonNullable<Parameters<typeof runScenario>[1]["mayApprove"]>;
  /** Wraps each session the host opens; tests use it to play a host that behaves differently. */
  readonly wrapSession?: (session: Session) => Session;
}

export interface AntigravityScenarioResult {
  readonly run: ScenarioRun;
  /** What the driver logged to the host's diagnostics. */
  readonly diagnostics: readonly DiagnosticEntry[];
}

/** A host with the recorder's process service and no tool server for threads: the recorded session gets no MCP server at all. */
function recorderHost(layout: AntigravityLayout, process: HostServices["process"]): HostServices<AntigravityConfig> & { readonly diagnosticEntries: readonly DiagnosticEntry[] } {
  const base = path.dirname(layout.stateDir);
  const paths = { stateDir: layout.stateDir, cacheDir: path.join(base, "cache"), tmpDir: path.join(base, "tmp") };
  const host = createFakeHost<AntigravityConfig>({ paths, envPolicy: ANTIGRAVITY_RECORDER_ENV_POLICY });
  return {
    ...host,
    process,
    hostTools: {
      ...host.hostTools,
      mcpServerFor: async () => {
        throw new Error("the recorder gives the session no tool server");
      },
    },
  };
}

/** Plays `scenario` through a fresh Antigravity driver whose agent processes start through `input.process`. */
export async function runAntigravityScenario(input: AntigravityScenarioInput): Promise<AntigravityScenarioResult> {
  const driver = createAntigravityDriver();
  const host = recorderHost(input.layout, input.process);
  const instance = await driver.create(host, { instanceId: ANTIGRAVITY_RECORDER_INSTANCE_ID, config: antigravityRecorderConfig(), environment: {} });
  try {
    const run = await runScenario(input.scenario, {
      openSession: async () => {
        const session = withModelChoice(await instance.openSession({}), input.models, input.pin);
        return input.wrapSession === undefined ? session : input.wrapSession(session);
      },
      cwd: input.layout.cwd,
      timeoutMs: input.timeoutMs,
      ...(input.mayApprove === undefined ? {} : { mayApprove: input.mayApprove }),
      ...(input.native === undefined ? {} : { native: input.native }),
    });
    return { run, diagnostics: host.diagnosticEntries };
  } finally {
    await instance.dispose();
  }
}

/** Inspect the ACP model picker without ever sending session/prompt. */
export async function listAntigravityModels(layout: AntigravityLayout, process: HostServices["process"], models: ModelChooser, pin?: AntigravityScenarioInput["pin"]): Promise<string[]> {
  const instance = await createAntigravityDriver().create(recorderHost(layout, process), {
    instanceId: ANTIGRAVITY_RECORDER_INSTANCE_ID, config: antigravityRecorderConfig(), environment: {},
  });
  try {
    const session = withModelChoice(await instance.openSession({}), models, pin);
    const thread = await session.createThread({ cwd: layout.cwd, policy: { cwd: layout.cwd, mode: "approval_required", interaction: "default" } });
    const option = await modelOptionOf(session, thread.id);
    return option === undefined ? [] : offered(option);
  } finally {
    await instance.dispose();
  }
}
