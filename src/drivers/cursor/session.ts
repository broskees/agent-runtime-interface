// A Cursor session: Cursor's local agents, run by the Cursor TypeScript SDK
// inside the host's own Node process (`sessionModel: "in_process"`). One
// SDK agent is one ARI thread; one run (`agent.send`) is one ARI turn.
//
// How the driver keeps Cursor's quirks:
// - A turn settles only when `run.wait()` resolves: Cursor ends a run after
//   every background subagent's result came back as a follow-up turn of the
//   same run (docs, "Background subagents"). Never on a timer, and never on a
//   `turn-ended` usage event, which a run can repeat.
// - A steer goes to `run.steer()`. Cursor answers `complete_delivered` when
//   the running turn took the message and `revert_to_followup` when it did
//   not (the run ended, or never took it); the host then gets
//   `prompt_required`.
// - Stop is `run.cancel()`; the run then ends `cancelled`.
// - Cursor has no fork, no rollback and no approval flow: a local run answers
//   its own interaction queries (dist/esm/977.js). `forkThread` and
//   `rollbackThread` reject with `unsupported`, and the host's fallbacks apply.
// - The agent store is a `JsonlLocalAgentStore` under the instance's state
//   directory, never the SDK's default store under ~/.cursor/projects.
// - Host instructions go at the top of the thread's first prompt (channel
//   `first_user_message`): Cursor's `systemPrompt` option replaces its whole
//   coding-agent prompt, so it cannot append. A resumed thread gets its
//   `launch` instructions the same way, on its first prompt after the resume.
// - Host MCP servers: `launch.mcpServers` go to `Agent.create` and
//   `Agent.resume` under the host's names. Cursor picks the agent id, so the
//   host's per-thread tool server (`hostTools.mcpServerFor`) is fetched once
//   the thread exists and sent with every run (`send({ mcpServers })`, which
//   the SDK documents as replacing the creation-time servers for that run).
//   A resume's servers join the thread's (a name it gives again takes the
//   new definition) and so reach every later run.
// - Resuming: the driver opens only agents its own instance created
//   (created-agents.ts); any other agent the store holds is refused with
//   `validation`, untouched. A resume's policy reaches Cursor or is refused:
//   a `read_only`/`full_access` change reopens the agent with its tools, which
//   waits for a running turn; a new working directory cannot apply, because
//   Cursor keeps a local agent in the directory it was created in.
// - Runs and Cursor's store: `Agent.create` reserves a queued first run that
//   only the handle it returned can take (index.js `getRunForSend`). Any other
//   handle (after a release, an unload, a restart, or in another session) gets
//   a follow-up run, which the store refuses while the agent's last run is
//   not terminal: that reservation, or a run a crashed process left. So a
//   turn sends with `local.force`, which expires such a run first (the SDK's
//   recovery path for wedged local agents). It does so under the agent's lock
//   (agent-runs.ts), shared by the instance's sessions: while a run of this
//   instance holds the agent or is being started on it, the turn is refused,
//   so no live run is ever expired.
// - A replacement agent (`session.replaced`) gets every host instruction the
//   lost thread was given, once, at the top of its first prompt: none of them
//   reached the new conversation.

import { callErrors, toCallError } from "../../errors.ts";
import { EventSequencer } from "../../driver-kit/sequencer.ts";
import { keepingMode } from "../../driver-kit/policy.ts";
import type { Capabilities } from "../../generated/capabilities.ts";
import type { ConfigValues, ContentBlock } from "../../generated/common.ts";
import type { ConfigChangePlan, EffectiveMode, RuntimePolicy } from "../../generated/config.ts";
import type { AriEventBody, AriEvent } from "../../generated/events.ts";
import type { Failure } from "../../generated/errors.ts";
import type { OpenSessionInput } from "../../generated/instance.ts";
import type {
  AppliedThread,
  CreateThreadInput,
  InterruptTurnInput,
  LaunchContext,
  LaunchMcpServer,
  PlanConfigChangeInput,
  RespondInput,
  ResumeThreadInput,
  StartTurnInput,
  StartTurnResult,
} from "../../generated/session.ts";
import type { HostToolServer } from "../../generated/host.ts";
import type { Thread, ThreadSnapshot } from "../../generated/thread.ts";
import type { HostServices, Session } from "../../runtime.ts";
import { cursorCapabilities } from "./capabilities.ts";
import type { AgentRuns, HeldRun } from "./agent-runs.ts";
import type { CursorConfig } from "./config.ts";
import type { CreatedAgents } from "./created-agents.ts";
import { IDENTITY_VERSION, RunFold, callErrorFromSdk, failureFromRunError, planIdFor, threadIdFor, turnIdFor } from "./mapping.ts";
import type { FoldSink } from "./mapping.ts";
import type { CursorAgentOptions, CursorImage, CursorInteractionUpdate, CursorMcpServerConfig, CursorRun, CursorRunResult, CursorSdk, CursorSdkAgent, CursorSendOptions, CursorUserMessage } from "./sdk.ts";

/** What the instance gives each session. */
export interface CursorSessionContext<Store> {
  readonly host: HostServices<CursorConfig>;
  readonly config: CursorConfig;
  readonly sdk: CursorSdk<Store>;
  /** The instance's agent store, under its state directory. */
  readonly store: Store;
  /** The account's API key, passed on every SDK call so the SDK never reads `CURSOR_API_KEY` itself. */
  readonly apiKey: string;
  /** The agents this instance created: the only ones `resumeThread` opens. */
  readonly createdAgents: CreatedAgents;
  /** The runs the instance's sessions start and hold, with one lock per agent. */
  readonly agentRuns: AgentRuns;
}

/**
 * The built-in tools a `read_only` thread offers the model (`AgentOptions.tools`):
 * reading and searching the workspace, and the todo and plan tools, which
 * write no file. No shell, no edits, no MCP (whose tools may write) and no
 * subagents (which keep their own toolsets).
 */
export const READ_ONLY_TOOLS: readonly string[] = ["read", "grep", "glob", "ls", "semSearch", "readLints", "readTodos", "updateTodos", "createPlan"];

const SUPPORTED_MODES: ReadonlySet<string> = new Set(["read_only", "full_access"]);

/**
 * A thread's mode. Without a mode the driver opens the agent with the options
 * it gives `full_access` (no tool allowlist), which a local agent runs with
 * every tool ("Sandbox options"), so the harness's own mode is `full_access`.
 */
function effectiveModeOf(policy: RuntimePolicy): EffectiveMode {
  return policy.mode === undefined ? { mode: "full_access", source: "harness" } : { mode: policy.mode, interaction: policy.interaction, source: "host" };
}
const SUPPORTED_INTERACTIONS: ReadonlySet<string> = new Set(["default", "plan"]);
const SUPPORTED_OPTIONS: ReadonlySet<string> = new Set(["model"]);

interface Envelope {
  threadId?: string;
  turnId?: string;
  hostTag?: string;
}

interface ActiveTurn {
  readonly id: string;
  readonly threadId: string;
  readonly hostTag: string | undefined;
  readonly run: CursorRun;
  /** Frees the agent for the instance's next run; called once the run ended. */
  readonly release: () => void;
  readonly fold: RunFold;
  /** True once the session stopped listening (it closed); the fold takes no more of the run's updates. */
  detached: boolean;
  settled: boolean;
}

interface CursorThread {
  thread: Thread;
  readonly agentId: string;
  readonly cwd: string;
  policy: RuntimePolicy;
  model: string;
  /** The launch MCP servers, given again to `Agent.resume` (the SDK keeps inline servers in memory only) and with every run. */
  launchServers: LaunchMcpServer[];
  /** The host's tool server for this thread, sent with every run. */
  hostServer: HostToolServer | undefined;
  /** Every host instruction the thread was given (launch and `context`, on creation and each resume), oldest first. */
  readonly instructions: string[];
  /** The ones not yet sent: they wait for the thread's next prompt. */
  pendingInstructions: string[];
  agent: CursorSdkAgent | undefined;
  opening: Promise<CursorSdkAgent> | undefined;
  active: ActiveTurn | undefined;
  compacting: boolean;
  unloaded: boolean;
}

/** The thread's servers after a resume: the resume's own, and every earlier one it does not name again. */
function mergedServers(kept: readonly LaunchMcpServer[], added: readonly LaunchMcpServer[]): LaunchMcpServer[] {
  return [...kept.filter((server) => !added.some((next) => next.name === server.name)), ...added];
}

function instructionsOf(launch: LaunchContext | undefined, context: { system?: string; developer?: string } | undefined): string[] {
  return [...(launch?.appendSystemPrompt ?? []), ...(launch?.developerPrompt ?? []), ...(context?.system === undefined ? [] : [context.system]), ...(context?.developer === undefined ? [] : [context.developer])].filter((text) => text !== "");
}

/** An ARI MCP server as Cursor's inline `McpServerConfig`. Cursor has no per-server tool-search setting, so `alwaysLoad` has nothing to set. */
function cursorMcpConfig(server: { transport: string; command?: string; args?: string[]; env?: { [name: string]: string }; cwd?: string; url?: string; headers?: { [name: string]: string } }): CursorMcpServerConfig {
  if (server.transport === "stdio") {
    return { type: "stdio", command: server.command ?? "", ...(server.args === undefined ? {} : { args: [...server.args] }), ...(server.env === undefined ? {} : { env: { ...server.env } }), ...(server.cwd === undefined ? {} : { cwd: server.cwd }) };
  }
  if (server.transport === "http" || server.transport === "sse") {
    return { type: server.transport, url: server.url ?? "", ...(server.headers === undefined ? {} : { headers: { ...server.headers } }) };
  }
  throw callErrors.unsupported("mcp.acceptsHostServers", `Cursor takes stdio, http and sse MCP servers, not ${server.transport}`);
}

export class CursorSession<Store> implements Session {
  readonly id: string;
  readonly #context: CursorSessionContext<Store>;
  readonly #input: OpenSessionInput;
  readonly #capabilities: Capabilities = cursorCapabilities();
  readonly #sequencer: EventSequencer;
  readonly #threads = new Map<string, CursorThread>();
  readonly #turnKeys = new Map<string, Promise<StartTurnResult>>();
  #closed = false;

  constructor(context: CursorSessionContext<Store>, input: OpenSessionInput, id: string) {
    this.id = id;
    this.#context = context;
    this.#input = input;
    this.#sequencer = new EventSequencer({ sessionId: id });
    this.#emit({ type: "capabilities.updated", capabilities: this.#capabilities });
    this.#emit({ type: "session.state", state: "ready" });
  }

  capabilities(): Capabilities {
    return this.#capabilities;
  }

  events(options?: { fromSeq?: number }): AsyncIterable<AriEvent> {
    return this.#sequencer.events(options?.fromSeq === undefined ? {} : { fromSeq: options.fromSeq });
  }

  // -------------------------------------------------------------------------
  // Threads

  async createThread(input: CreateThreadInput): Promise<AppliedThread> {
    this.#open();
    this.#checkPolicy(input.policy);
    const launch = this.#launch(input.launch);
    const model = this.#model(input.config, this.#defaultModel());
    const cwd = await this.#canonical(input.cwd);
    let agent: CursorSdkAgent;
    try {
      agent = await this.#context.sdk.Agent.create({ ...this.#agentOptions(cwd, model, input.policy, launch.servers), ...(input.title === undefined ? {} : { name: input.title }) });
    } catch (error) {
      throw callErrorFromSdk(error, "Agent.create");
    }
    await this.#recordCreated(agent);
    const thread = await this.#register(agent, cwd, input.policy, model, launch.servers, [...launch.instructions, ...instructionsOf(undefined, input.context)], input.title);
    return { ...thread.thread, appliedConfig: { model } };
  }

  async resumeThread(input: ResumeThreadInput): Promise<AppliedThread> {
    this.#open();
    const field = "handle" in input.native ? "handle" : "id";
    const agentId = "handle" in input.native ? input.native.handle : input.native.id;
    if (agentId === null || agentId === "") throw callErrors.validation([{ message: "resumeThread needs a native id or handle", path: ["native"] }]);
    const known = this.#threads.get(threadIdFor(agentId));
    if (known !== undefined) return this.#resumeKnown(known, input);
    const launch = this.#launch(input.launch);
    const policy = input.policy;
    if (policy === undefined) throw callErrors.validation([{ message: "resuming a Cursor agent this session does not know needs policy.cwd: Cursor finds a local agent by its working directory", path: ["policy", "cwd"] }]);
    this.#checkPolicy(policy);
    const model = this.#model(input.config, this.#defaultModel());
    const cwd = await this.#canonical(policy.cwd);
    const created = await this.#context.createdAgents.has(agentId);
    let agent: CursorSdkAgent;
    try {
      // Agent.resume only reads the agent's row (index.js `resumeAgent`), so it also tells whether the store holds an agent this instance did not create.
      agent = await this.#context.sdk.Agent.resume(agentId, this.#agentOptions(cwd, model, policy, launch.servers));
    } catch (error) {
      const failure = callErrorFromSdk(error, "Agent.resume");
      if (failure.code !== "not_found") throw failure;
      return this.#replace(agentId, failure, cwd, policy, model, launch.servers, launch.instructions);
    }
    if (!created) {
      this.#closeHandle(agentId, agent);
      throw callErrors.validation(
        [
          {
            message: `The Cursor driver resumes only agents its own instance created. Cursor keeps the host's launch instructions in the conversation of the agent it runs, so it will not open agent ${agentId}, which this instance did not create.`,
            path: ["native", field],
          },
        ],
        "The Cursor agent was not created by this instance",
      );
    }
    const thread = await this.#register(agent, cwd, policy, model, launch.servers, launch.instructions, undefined);
    return { ...thread.thread, appliedConfig: { model } };
  }

  /**
   * A resume of a thread this session holds. What Cursor can apply reaches it
   * on the next run: new instructions (the next prompt), servers and model
   * (every run), and a `read_only`/`full_access` change, for which the agent
   * reopens with its tools. What it cannot apply is refused before anything
   * changes. A thread without an open agent (released or unloaded) reopens now.
   */
  async #resumeKnown(thread: CursorThread, input: ResumeThreadInput): Promise<AppliedThread> {
    const launch = this.#launch(input.launch);
    // A policy without a mode keeps the thread's.
    const policy = input.policy === undefined ? thread.policy : keepingMode(input.policy, thread.policy);
    this.#checkPolicy(policy);
    const model = this.#model(input.config, thread.model);
    if (input.policy !== undefined && (await this.#canonical(input.policy.cwd)) !== thread.cwd) {
      throw callErrors.invalidState("cwd_changed", `Cursor keeps a local agent in the directory it was created in (${thread.cwd}), so thread ${thread.thread.id} cannot resume in ${input.policy.cwd}`);
    }
    const reopen = policy.mode !== thread.policy.mode;
    if (reopen && (thread.active !== undefined || thread.compacting || thread.opening !== undefined)) {
      throw callErrors.invalidState("turn_active", `Cursor sets an agent's tools when it opens the agent, so thread ${thread.thread.id} cannot change to ${policy.mode ?? "Cursor's own mode"} while a run is going`);
    }
    const servers = mergedServers(thread.launchServers, launch.servers);
    // The session's own launch instructions reached this thread when it was created or first resumed here.
    const added = instructionsOf(input.launch, undefined);
    if (thread.opening !== undefined) await thread.opening.catch(() => undefined);
    if (reopen) this.#closeAgent(thread);
    if (thread.agent === undefined) {
      let agent: CursorSdkAgent;
      try {
        agent = await this.#context.sdk.Agent.resume(thread.agentId, this.#agentOptions(thread.cwd, model, policy, servers));
      } catch (error) {
        const failure = callErrorFromSdk(error, "Agent.resume");
        if (failure.code !== "not_found" || input.policy === undefined) throw failure;
        return this.#replace(thread.agentId, failure, thread.cwd, policy, model, servers, [...thread.instructions, ...added]);
      }
      thread.agent = agent;
      if (thread.unloaded) {
        thread.unloaded = false;
        thread.thread = { ...thread.thread, status: "idle" };
        this.#emit({ type: "thread.upsert", thread: { id: thread.thread.id, status: "idle" } }, { threadId: thread.thread.id });
      }
    }
    // Only a resume that succeeded changes the thread.
    thread.policy = policy;
    this.#refreshMode(thread);
    thread.model = model;
    thread.launchServers = servers;
    thread.instructions.push(...added);
    thread.pendingInstructions.push(...added);
    return { ...thread.thread, appliedConfig: { model } };
  }

  /** The resumed agent is gone: a fresh agent, and `session.replaced` saying the old conversation is lost. `instructions` go at the top of its first prompt. */
  async #replace(previousId: string, failure: Error, cwd: string, policy: RuntimePolicy, model: string, servers: LaunchMcpServer[], instructions: string[]): Promise<AppliedThread> {
    let fresh: CursorSdkAgent;
    try {
      fresh = await this.#context.sdk.Agent.create(this.#agentOptions(cwd, model, policy, servers));
    } catch (createError) {
      throw callErrorFromSdk(createError, "Agent.create");
    }
    await this.#recordCreated(fresh);
    this.#emit({ type: "session.replaced", previousNativeId: previousId, reason: `Cursor could not resume agent ${previousId}: ${failure.message}`, contextLost: true, showRuntimeNote: true }, { threadId: threadIdFor(fresh.agentId) });
    const replacement = await this.#register(fresh, cwd, policy, model, servers, instructions, undefined);
    return { ...replacement.thread, appliedConfig: { model } };
  }

  /** Cursor's SDK has no fork: nothing makes a new agent from another agent's conversation. */
  async forkThread(): Promise<Thread> {
    this.#open();
    throw callErrors.unsupported("threads.fork", "Cursor's SDK cannot fork an agent's conversation");
  }

  /** Cursor's SDK has no rollback: nothing rewinds an agent's conversation. */
  async rollbackThread(): Promise<ThreadSnapshot> {
    this.#open();
    throw callErrors.unsupported("threads.rollback", "Cursor's SDK cannot roll back an agent's conversation");
  }

  async compactThread(threadId: string): Promise<void> {
    this.#open();
    const thread = this.#thread(threadId);
    if (thread.active !== undefined || thread.compacting) throw callErrors.invalidState("turn_active", "Cursor summarizes a conversation only between runs");
    thread.compacting = true;
    try {
      const agent = await this.#agent(thread);
      // A summary is a run in Cursor's store, started and held like a turn's (agent-runs.ts). It cannot force.
      let held: HeldRun<CursorRun>;
      try {
        held = await this.#context.agentRuns.start(thread.agentId, () => agent.summarize());
      } catch (error) {
        const failure = callErrorFromSdk(error, "agent.summarize");
        throw failure.code === "validation" ? callErrors.invalidState("nothing_to_compact", failure.message) : failure;
      }
      let result: CursorRunResult;
      try {
        result = await held.value.wait();
      } finally {
        held.release();
      }
      if (result.status === "error") {
        const failure = failureFromRunError(result.error);
        throw callErrors.protocol(failure.code ?? "summarize_failed", `Cursor could not summarize the conversation: ${failure.message}`);
      }
      if (result.status === "cancelled") throw callErrors.invalidState("compaction_cancelled", "The summary run was cancelled");
    } finally {
      thread.compacting = false;
    }
  }

  async unloadThread(threadId: string): Promise<void> {
    this.#open();
    const thread = this.#thread(threadId);
    if (thread.active !== undefined || thread.compacting) throw callErrors.invalidState("turn_active");
    this.#closeAgent(thread);
    thread.unloaded = true;
    thread.thread = { ...thread.thread, status: "unloaded" };
    this.#emit({ type: "thread.upsert", thread: { id: threadId, status: "unloaded" } }, { threadId });
  }

  canRelease(): boolean {
    if (this.#closed) return false;
    return ![...this.#threads.values()].some((thread) => thread.active !== undefined || thread.compacting || thread.opening !== undefined);
  }

  /** Closes every agent handle, which frees its local executor; each thread reopens with `Agent.resume` when next used. */
  async release(): Promise<void> {
    this.#open();
    if (!this.canRelease()) throw callErrors.invalidState("release_vetoed", "A run, a summary or an agent opening is still in progress");
    for (const thread of this.#threads.values()) this.#closeAgent(thread);
  }

  // -------------------------------------------------------------------------
  // Turns

  startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    this.#open();
    // A retry with the same clientTurnKey never sends twice.
    const prior = this.#turnKeys.get(input.clientTurnKey);
    if (prior !== undefined) return prior;
    const started = this.#startTurn(input);
    this.#turnKeys.set(input.clientTurnKey, started);
    started.catch(() => this.#turnKeys.delete(input.clientTurnKey));
    return started;
  }

  async #startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    const thread = this.#thread(input.threadId);
    if (input.intent === "queue") return { status: "unsupported", capability: "turns.queue" };
    if (input.intent !== "start" && input.intent !== "steer") return { status: "unsupported", capability: `turns.${String(input.intent)}` };
    if (input.context?.synthetic !== undefined && input.context.synthetic.length > 0) return { status: "unsupported", capability: "context.syntheticContext" };
    const policy = input.policy === undefined ? thread.policy : keepingMode(input.policy, thread.policy);
    if (policy.mode !== thread.policy.mode) return { status: "unsupported", capability: "sessions.switchRuntimeMode" };
    if (!SUPPORTED_INTERACTIONS.has(policy.interaction)) return { status: "unsupported", capability: "runtimePolicy.interactionModes" };
    const prompt = await this.#promptOf(input.content);
    if (input.intent === "steer") return this.#steer(thread, input, prompt);

    if (thread.active !== undefined || thread.compacting) throw callErrors.invalidState("previous_turn_active", `Thread ${thread.thread.id} already runs a turn`);
    const model = this.#model(input.config, thread.model);
    const sentPending = thread.pendingInstructions.length;
    const instructions = [...thread.pendingInstructions, ...instructionsOf(undefined, input.context)];
    const text = instructions.length === 0 ? prompt.text : `${instructions.join("\n\n")}\n\n${prompt.text}`;
    const message: string | CursorUserMessage = prompt.images.length === 0 ? text : { text, images: prompt.images };
    const servers = this.#runServers(thread);
    // The SDK may deliver updates before `send()` resolves; they wait here until the turn is open.
    const early: CursorInteractionUpdate[] = [];
    let deliver: ((update: CursorInteractionUpdate) => void) | undefined;
    const options: CursorSendOptions = {
      // Always the model: the agent may have opened with an earlier one.
      model: { id: model },
      mode: policy.interaction === "plan" ? "plan" : "agent",
      ...(servers === undefined ? {} : { mcpServers: servers }),
      onDelta: ({ update }) => {
        if (deliver === undefined) early.push(update);
        else deliver(update);
      },
    };
    const agent = await this.#agent(thread);
    if (thread.active !== undefined) throw callErrors.invalidState("previous_turn_active", `Thread ${thread.thread.id} already runs a turn`);
    // Under the agent's lock, and only when no run of this instance holds the agent: then any run
    // Cursor's store still holds as active is one nothing here runs, and forcing expires it.
    let held: HeldRun<CursorRun>;
    try {
      held = await this.#context.agentRuns.start(thread.agentId, () => agent.send(message, { ...options, local: { force: true } }));
    } catch (error) {
      throw callErrorFromSdk(error, "agent.send");
    }
    const run = held.value;
    // Instructions a resume added while this turn waited stay for the next prompt.
    thread.pendingInstructions.splice(0, sentPending);
    thread.model = model;
    const turn = this.#openTurn(thread, run, input, prompt.text, model, held.release);
    deliver = (update) => {
      if (!turn.detached && !turn.settled) turn.fold.consume(update);
    };
    for (const update of early.splice(0)) deliver(update);
    void this.#pump(thread, turn);
    return { status: "accepted", turnId: turn.id, accepted: "started" };
  }

  async #steer(thread: CursorThread, input: StartTurnInput, prompt: { text: string; images: CursorImage[] }): Promise<StartTurnResult> {
    const active = thread.active;
    if (active === undefined || active.settled || (input.expectedTurnId !== undefined && input.expectedTurnId !== active.id)) return { status: "prompt_required" };
    if (input.context !== undefined && (input.context.system !== undefined || input.context.developer !== undefined)) return { status: "unsupported", capability: "context.instructionChannels" };
    if (prompt.images.length > 0) throw callErrors.validation([{ message: "Cursor's run.steer takes text only", path: ["content"] }]);
    const steer = active.run.steer;
    if (steer === undefined) return { status: "prompt_required" };
    let outcome;
    try {
      outcome = await steer.call(active.run, prompt.text);
    } catch (error) {
      throw callErrorFromSdk(error, "run.steer");
    }
    if (outcome === "complete_delivered") return { status: "accepted", turnId: active.id, accepted: "steered" };
    if (outcome === "revert_to_followup") return { status: "prompt_required" };
    // Only cloud runs answer a steer by queueing a follow-up run, and this driver runs local agents.
    throw callErrors.protocol("steer_queued", "Cursor queued the steer as a follow-up run, which a local agent does not do");
  }

  async interruptTurn(input: InterruptTurnInput): Promise<void> {
    this.#open();
    const thread = [...this.#threads.values()].find((candidate) => candidate.active?.id === input.turnId);
    const turn = thread?.active;
    if (thread === undefined || turn === undefined || turn.settled) return;
    try {
      await turn.run.cancel();
    } catch (error) {
      throw callErrorFromSdk(error, "run.cancel");
    }
    // Stop and close the agent too; the thread reopens with Agent.resume when next used.
    if (input.restartRuntime === true) this.#closeAgent(thread);
  }

  /** Cursor raises no requests (a local run answers its own interaction queries), so there is none to answer. */
  async respond(input: RespondInput): Promise<void> {
    this.#open();
    throw callErrors.notFound({ resource: "request", id: input.requestId, message: `No request ${input.requestId}: Cursor's SDK raises no requests` });
  }

  async planConfigChange(input: PlanConfigChangeInput): Promise<ConfigChangePlan> {
    this.#thread(input.threadId);
    const unknown = Object.keys(input.changes).filter((key) => !SUPPORTED_OPTIONS.has(key));
    if (unknown.length > 0) return { type: "reject", reason: `Cursor has no option ${unknown.join(", ")}` };
    return { type: "apply_next_turn" };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const thread of this.#threads.values()) {
      const turn = thread.active;
      if (turn !== undefined) {
        turn.detached = true;
        void turn.run.cancel().catch(() => undefined);
        this.#settle(thread, turn, "interrupted");
      }
      this.#closeAgent(thread);
    }
    this.#emit({ type: "session.state", state: "stopped" });
    this.#sequencer.close();
  }

  // -------------------------------------------------------------------------
  // Agents

  #agentOptions(cwd: string, model: string, policy: RuntimePolicy, servers: readonly LaunchMcpServer[]): CursorAgentOptions<Store> {
    const settingSources = this.#context.config.settingSources;
    const mcpServers = this.#serverRecord(servers, undefined);
    return {
      apiKey: this.#context.apiKey,
      model: { id: model },
      local: { cwd, store: this.#context.store, ...(settingSources === undefined || settingSources.length === 0 ? {} : { settingSources: [...settingSources] }) },
      ...(mcpServers === undefined ? {} : { mcpServers }),
      ...(policy.mode === "read_only" ? { tools: [...READ_ONLY_TOOLS] } : {}),
    };
  }

  async #register(agent: CursorSdkAgent, cwd: string, policy: RuntimePolicy, model: string, servers: LaunchMcpServer[], instructions: string[], title: string | undefined): Promise<CursorThread> {
    const id = threadIdFor(agent.agentId);
    const thread: CursorThread = {
      thread: { id, native: { id: agent.agentId, strength: "strong" }, cwd, status: "idle", handle: agent.agentId, identityVersion: IDENTITY_VERSION, ...(title === undefined ? {} : { title }), effectiveMode: effectiveModeOf(policy) },
      agentId: agent.agentId,
      cwd,
      policy,
      model,
      launchServers: servers,
      hostServer: undefined,
      instructions: [...instructions],
      pendingInstructions: [...instructions],
      agent,
      opening: undefined,
      active: undefined,
      compacting: false,
      unloaded: false,
    };
    this.#threads.set(id, thread);
    this.#emit({ type: "thread.upsert", thread: thread.thread }, { threadId: id });
    try {
      thread.hostServer = await this.#context.host.hostTools.mcpServerFor(id, { transport: "http" });
    } catch (error) {
      this.#context.host.diagnostics.log({ level: "warn", msg: `The host gave no tool server for thread ${id}: ${error instanceof Error ? error.message : String(error)}` });
    }
    return thread;
  }

  /** The thread's open agent handle, reopened with `Agent.resume` after an unload, a release or a restart. */
  async #agent(thread: CursorThread): Promise<CursorSdkAgent> {
    if (thread.agent !== undefined) return thread.agent;
    if (thread.opening !== undefined) return thread.opening;
    const opening = this.#context.sdk.Agent.resume(thread.agentId, this.#agentOptions(thread.cwd, thread.model, thread.policy, thread.launchServers));
    thread.opening = opening;
    try {
      const agent = await opening;
      thread.agent = agent;
      if (thread.unloaded) {
        thread.unloaded = false;
        thread.thread = { ...thread.thread, status: "idle" };
        this.#emit({ type: "thread.upsert", thread: { id: thread.thread.id, status: "idle" } }, { threadId: thread.thread.id });
      }
      return agent;
    } catch (error) {
      throw callErrorFromSdk(error, "Agent.resume");
    } finally {
      thread.opening = undefined;
    }
  }

  #closeAgent(thread: CursorThread): void {
    const agent = thread.agent;
    thread.agent = undefined;
    if (agent !== undefined) this.#closeHandle(thread.agentId, agent);
  }

  #closeHandle(agentId: string, agent: CursorSdkAgent): void {
    try {
      agent.close();
    } catch (error) {
      this.#context.host.diagnostics.log({ level: "warn", msg: `Closing Cursor agent ${agentId} failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  /** Records a new agent as this instance's own, so a later resume opens it. */
  async #recordCreated(agent: CursorSdkAgent): Promise<void> {
    try {
      await this.#context.createdAgents.add(agent.agentId);
    } catch (error) {
      this.#closeHandle(agent.agentId, agent);
      throw error;
    }
  }

  /** The servers of one run: the launch servers and the host's tool server for the thread, under the host's names. */
  #runServers(thread: CursorThread): Record<string, CursorMcpServerConfig> | undefined {
    return this.#serverRecord(thread.launchServers, thread.hostServer);
  }

  #serverRecord(servers: readonly LaunchMcpServer[], hostServer: HostToolServer | undefined): Record<string, CursorMcpServerConfig> | undefined {
    const record: Record<string, CursorMcpServerConfig> = {};
    for (const server of servers) record[server.name] = cursorMcpConfig(server);
    if (hostServer !== undefined) record[hostServer.name] = cursorMcpConfig(hostServer.config);
    return Object.keys(record).length === 0 ? undefined : record;
  }

  // -------------------------------------------------------------------------
  // Runs

  #openTurn(thread: CursorThread, run: CursorRun, input: StartTurnInput, promptText: string, model: string, release: () => void): ActiveTurn {
    const id = turnIdFor(thread.thread.id, run.id);
    const envelope: Envelope = { threadId: thread.thread.id, turnId: id, ...(input.hostTag === undefined ? {} : { hostTag: input.hostTag }) };
    const sink: FoldSink = {
      item: (patch) => this.#emit({ type: "item.upsert", item: patch }, envelope),
      delta: (itemId, field, chunk) => this.#emit({ type: "item.delta", itemId, field, chunk }, envelope),
      subagent: (patch) => this.#emit({ type: "subagent.upsert", subagent: patch }, envelope),
      plan: (patch) => this.#emit({ type: "plan.upsert", plan: patch }, envelope),
      usage: (usage) => this.#emit({ type: "usage.updated", usage }, envelope),
    };
    const fold = new RunFold(
      {
        threadId: thread.thread.id,
        turnId: id,
        planId: planIdFor(thread.thread.id),
        emitDiffs: this.#input.emitDiffs !== false,
        model,
        now: () => new Date().toISOString(),
        ...(this.#input.payloadLimits?.maxToolOutputBytes === undefined ? {} : { maxToolOutputBytes: this.#input.payloadLimits.maxToolOutputBytes }),
        ...(this.#input.payloadLimits?.maxDiffBytes === undefined ? {} : { maxDiffBytes: this.#input.payloadLimits.maxDiffBytes }),
      },
      sink,
    );
    const turn: ActiveTurn = { id, threadId: thread.thread.id, hostTag: input.hostTag, run, release, fold, detached: false, settled: false };
    thread.active = turn;
    thread.thread = { ...thread.thread, status: "running" };
    this.#emit(
      {
        type: "turn.upsert",
        turn: {
          id,
          threadId: thread.thread.id,
          native: { id: run.id, strength: "strong" },
          origin: "user",
          status: "running",
          startedAt: new Date().toISOString(),
          clientTurnKey: input.clientTurnKey,
          ...(input.hostTag === undefined ? {} : { hostTag: input.hostTag }),
          model,
        },
      },
      envelope,
    );
    fold.prompt(promptText);
    return turn;
  }

  /**
   * Settles the turn the way `run.wait()` says the run ended. The run's
   * updates reach the fold through `onDelta`, which the SDK awaits before it
   * ends the run; the run's own message stream is only drained, so its
   * buffer does not grow.
   */
  async #pump(thread: CursorThread, turn: ActiveTurn): Promise<void> {
    void (async () => {
      try {
        for await (const message of turn.run.stream()) void message;
      } catch {
        // The stream is not the driver's source of events.
      }
    })();
    let status: "completed" | "interrupted" | "failed";
    let failure: Failure | undefined;
    try {
      const result = await turn.run.wait();
      if (result.status === "finished") status = "completed";
      else if (result.status === "cancelled") status = "interrupted";
      else {
        status = "failed";
        failure = failureFromRunError(result.error);
      }
    } catch (error) {
      const sdkError = toCallError(error) === undefined ? error : undefined;
      status = "failed";
      failure = failureFromRunError({ message: error instanceof Error ? error.message : String(error), ...(typeof (sdkError as { code?: unknown } | undefined)?.code === "string" ? { code: (sdkError as { code: string }).code } : {}) });
    }
    // The run ended, and Cursor's store has it terminal: the instance may start the agent's next run. A closed
    // session's turn settled earlier, but its run held the agent until now.
    turn.release();
    if (turn.detached) return;
    this.#settle(thread, turn, status, failure);
  }

  /** Ends a turn: settles what it left open, then emits its status and its one `turn.terminal`. A Cursor agent takes the next run after any outcome. */
  #settle(thread: CursorThread, turn: ActiveTurn, status: "completed" | "interrupted" | "failed", failure?: Failure): void {
    if (thread.active === turn) thread.active = undefined;
    if (turn.settled) return;
    turn.settled = true;
    thread.thread = { ...thread.thread, status: thread.unloaded ? "unloaded" : "idle" };
    const envelope: Envelope = { threadId: turn.threadId, turnId: turn.id, ...(turn.hostTag === undefined ? {} : { hostTag: turn.hostTag }) };
    turn.fold.finish(status);
    this.#emit({ type: "turn.upsert", turn: { id: turn.id, status, completedAt: new Date().toISOString(), ...(failure === undefined ? {} : { failure }) } }, envelope);
    this.#emit({ type: "turn.terminal", turnId: turn.id, status, ...(failure === undefined ? {} : { failure }), threadDisposition: "reusable" }, envelope);
  }

  // -------------------------------------------------------------------------
  // Helpers

  /** Records the thread's mode after its policy changed, and tells the host when it did. */
  #refreshMode(thread: CursorThread): void {
    const effectiveMode = effectiveModeOf(thread.policy);
    if (JSON.stringify(effectiveMode) === JSON.stringify(thread.thread.effectiveMode)) return;
    thread.thread = { ...thread.thread, effectiveMode };
    this.#emit({ type: "thread.upsert", thread: { id: thread.thread.id, effectiveMode } }, { threadId: thread.thread.id });
  }

  #checkPolicy(policy: RuntimePolicy): void {
    if (policy.mode !== undefined && !SUPPORTED_MODES.has(policy.mode)) throw callErrors.unsupported(`runtimePolicy.modes.${policy.mode}`);
    if (!SUPPORTED_INTERACTIONS.has(policy.interaction)) throw callErrors.unsupported("runtimePolicy.interactionModes");
  }

  #launch(threadLaunch: LaunchContext | undefined): { servers: LaunchMcpServer[]; instructions: string[] } {
    const launches = [this.#input.launch, threadLaunch];
    if (launches.some((launch) => (launch?.dynamicTools ?? []).length > 0)) throw callErrors.unsupported("tools.dynamicTools");
    const servers: LaunchMcpServer[] = [];
    for (const launch of launches) {
      for (const server of launch?.mcpServers ?? []) {
        cursorMcpConfig(server);
        if (!servers.some((kept) => kept.name === server.name)) servers.push(server);
      }
    }
    return { servers, instructions: launches.flatMap((launch) => instructionsOf(launch, undefined)) };
  }

  /** The model a call asks for (`config.model`), checked; `fallback` when it names none. */
  #model(config: ConfigValues | undefined, fallback: string): string {
    const unknown = Object.keys(config ?? {}).filter((key) => !SUPPORTED_OPTIONS.has(key));
    if (unknown.length > 0) throw callErrors.validation(unknown.map((key) => ({ message: `Cursor has no option ${key}`, path: ["config", key] })));
    const model = config?.["model"];
    if (model === undefined) return fallback;
    if (typeof model !== "string" || model === "") throw callErrors.validation([{ message: "model is a Cursor model id", path: ["config", "model"] }]);
    return model;
  }

  /** The model a new thread starts with: the session's `config.model`, else the instance's. */
  #defaultModel(): string {
    const sessionModel = this.#input.config?.["model"];
    return typeof sessionModel === "string" && sessionModel !== "" ? sessionModel : this.#context.config.model;
  }

  /** The directory as its real path, so a workspace reached through a symbolic link gives the same agent scope. */
  async #canonical(cwd: string): Promise<string> {
    const fs = await import("node:fs/promises");
    try {
      return await fs.realpath(cwd);
    } catch {
      throw callErrors.validation([{ message: `The working directory ${cwd} does not exist`, path: ["cwd"] }]);
    }
  }

  /** The prompt text and images. Host files reach Cursor as paths; an unreadable one is named as such. */
  async #promptOf(content: readonly ContentBlock[]): Promise<{ text: string; images: CursorImage[] }> {
    const lines: string[] = [];
    const images: CursorImage[] = [];
    for (const block of content) {
      if (block.type === "text") lines.push(block.text);
      else if (block.type === "image" && block.data !== undefined) images.push({ data: block.data, mimeType: block.mimeType ?? "image/png" });
      // Cursor takes URL images only for cloud agents, so the URL goes in the text.
      else if (block.type === "image" && block.url !== undefined) lines.push(block.url);
      else if (block.type === "resource_link") lines.push(block.uri);
      else if ("attachmentRef" in block && block.attachmentRef !== undefined) {
        const resolved = await this.#context.host.attachments.resolve(block.attachmentRef);
        lines.push(resolved === null ? `(attachment ${block.attachmentRef} could not be read)` : resolved.path);
      }
    }
    if (lines.length === 0 && images.length === 0) throw callErrors.validation([{ message: "a turn needs content", path: ["content"] }]);
    return { text: lines.join("\n"), images };
  }

  #open(): void {
    if (this.#closed) throw callErrors.invalidState("session_closed");
  }

  #thread(threadId: string): CursorThread {
    const thread = this.#threads.get(threadId);
    if (thread === undefined) throw callErrors.notFound({ resource: "thread", id: threadId });
    return thread;
  }

  #emit(body: AriEventBody, envelope: Envelope = {}): void {
    if (this.#sequencer.closed) return;
    this.#sequencer.emit({ body, ...envelope });
  }
}
