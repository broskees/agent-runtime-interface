// The conformance kit's own rules: the scenario list, when a scenario may
// report "not applicable", the fake host's record, virtual time, the
// node:test adapter, and the gated-member table against methods.json.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import {
  GATED_MEMBERS,
  HOST_OPERATIONS,
  SCENARIOS,
  ScenarioContext,
  VirtualClock,
  conformanceTests,
  createConformanceSuite,
  createFakeHost,
  referenceHarness,
} from "../../src/conformance/index.ts";
import type { ConformanceHarness, ConformanceReport, NodeTestContext, ReferenceDriverConfig } from "../../src/conformance/index.ts";
import { callErrors, isAriError } from "../../src/index.ts";
import type { Session, SpawnedProcess } from "../../src/index.ts";
import { brokenHarness, override, runScenario } from "./broken-drivers.ts";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

describe("the scenario list", () => {
  test("holds the 15 scenarios of the inventory, numbered 1 to 15 with unique keys", () => {
    assert.deepEqual(
      SCENARIOS.map((scenario) => scenario.id),
      Array.from({ length: 15 }, (_, index) => index + 1),
    );
    assert.equal(new Set(SCENARIOS.map((scenario) => scenario.key)).size, 15);
  });

  test("runs the grammar scenario last, because it judges every other scenario's streams", () => {
    const suite = createConformanceSuite(referenceHarness());
    assert.deepEqual(
      suite.order.map((scenario) => scenario.id),
      [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 1],
    );
    assert.throws(() => createConformanceSuite(referenceHarness(), { scenarios: ["no-such-scenario"] }), /unknown conformance scenario/);
  });

  test("no module of ari/conformance imports a Node built-in or a test runner", () => {
    const directory = path.join(root, "src/conformance");
    const files = fs.readdirSync(directory, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts"));
    assert.ok(files.length > 10);
    for (const file of files) {
      const text = fs.readFileSync(path.join(directory, file), "utf8");
      assert.doesNotMatch(text, /^\s*import[^;]*from\s+["'](node:|vitest|bun:test|mocha|jest)/m, file);
    }
  });
});

/** The reference harness with some rig members removed. */
function adjustedHarness(
  options: {
    notApplicable?: { [key: string]: string };
    withoutLockSession?: boolean;
    withoutFileWatch?: boolean;
    withoutInspectSession?: boolean;
    withoutActivity?: boolean;
    withoutCompleteHeld?: boolean;
  } = {},
): ConformanceHarness<ReferenceDriverConfig> {
  const base = referenceHarness({ ...(options.notApplicable === undefined ? {} : { notApplicable: options.notApplicable }) });
  return {
    ...base,
    async setup(request) {
      const rig = await base.setup(request);
      const { lockSession, inspectSession, activity, ...otherNative } = rig.native;
      const { watchInstanceFiles: _watch, ...withoutWatch } = rig;
      const nextTurn = async () => {
        const { completeHeld: _held, ...turn } = await rig.native.nextTurn();
        return options.withoutCompleteHeld === true ? turn : { ...turn, completeHeld: _held };
      };
      return {
        ...(options.withoutFileWatch === true ? withoutWatch : rig),
        native: {
          ...otherNative,
          nextTurn,
          ...(options.withoutLockSession === true ? {} : { lockSession }),
          ...(options.withoutInspectSession === true ? {} : { inspectSession }),
          ...(options.withoutActivity === true ? {} : { activity }),
        },
      };
    },
  };
}

describe("not applicable only for a declared capability or a stated reason", () => {
  test("a harness reason makes a scenario not applicable, and the report shows it", async () => {
    const result = await runScenario(adjustedHarness({ notApplicable: { settlement: "the agent cannot run tools" } }), "settlement");
    assert.equal(result.status, "not_applicable");
    assert.equal(result.notApplicableBy, "harness");
    assert.equal(result.reason, "the agent cannot run tools");
  });

  test("a reason under idempotent-responses.full-access skips scenario 15's full_access part with a note, and the rest still runs", async () => {
    const reason = "the native agent sends no approval under full_access";
    const result = await runScenario(adjustedHarness({ notApplicable: { "idempotent-responses.full-access": reason } }), "idempotent-responses");
    assert.equal(result.status, "passed", result.reason);
    assert.ok(result.notes.includes(`the narrowest reply under full_access not checked (idempotent-responses.full-access): ${reason}`), result.notes.join("\n"));
    const unchanged = await runScenario(adjustedHarness(), "idempotent-responses");
    assert.ok(unchanged.notes.some((note) => /the driver (answered the full_access approval itself|handed the full_access approval to the host)/.test(note)), unchanged.notes.join("\n"));
  });

  test("a reason that is empty or spans two lines is a failure, not a pass", async () => {
    for (const reason of ["", "   ", "first line\nsecond line"]) {
      const result = await runScenario(adjustedHarness({ notApplicable: { settlement: reason } }), "settlement");
      assert.equal(result.status, "failed", JSON.stringify(reason));
      assert.match(result.reason ?? "", /must be one non-empty line/);
    }
  });

  test("a check the harness cannot support fails the scenario unless the harness gives a reason", async () => {
    const missing = await runScenario(adjustedHarness({ withoutLockSession: true }), "session-replaced");
    assert.equal(missing.status, "failed");
    assert.match(missing.reason ?? "", /has no lockSession; add it, or give a reason under session-replaced\.locked/);

    const excused = await runScenario(adjustedHarness({ withoutLockSession: true, notApplicable: { "session-replaced.locked": "the provider has no session locks" } }), "session-replaced");
    assert.equal(excused.status, "passed", excused.reason);
    assert.deepEqual(excused.notes, ["resuming a locked native session not checked (session-replaced.locked): the provider has no session locks"]);

    const noFiles = await runScenario(adjustedHarness({ withoutFileWatch: true }), "side-effect-free-probe");
    assert.equal(noFiles.status, "failed");
    assert.match(noFiles.reason ?? "", /add watchInstanceFiles, or give a reason under side-effect-free-probe\.files/);

    const noHeldCompletion = await runScenario(adjustedHarness({ withoutCompleteHeld: true }), "steer-after-end");
    assert.equal(noHeldCompletion.status, "failed");
    assert.match(noHeldCompletion.reason ?? "", /has no completeHeld; add it, or give a reason under steer-after-end\.race/);
    const heldExcused = await runScenario(
      adjustedHarness({ withoutCompleteHeld: true, notApplicable: { "steer-after-end.race": "the provider announces every turn end before it answers anything else" } }),
      "steer-after-end",
    );
    assert.equal(heldExcused.status, "passed", heldExcused.reason);

    const noInspect = await runScenario(adjustedHarness({ withoutInspectSession: true }), "capability-honesty");
    assert.equal(noInspect.status, "failed");
    assert.match(noInspect.reason ?? "", /the native agent has no inspectSession; add it to the harness, or give a reason under capability-honesty\.native-effects/);
    const inspectExcused = await runScenario(
      adjustedHarness({ withoutInspectSession: true, notApplicable: { "capability-honesty.native-effects": "the vendor's protocol cannot report session state" } }),
      "capability-honesty",
    );
    assert.equal(inspectExcused.status, "passed", inspectExcused.reason);
    assert.ok(inspectExcused.notes.some((note) => /not checked \(capability-honesty\.native-effects\)/.test(note)), inspectExcused.notes.join("\n"));

    const noActivity = await runScenario(adjustedHarness({ withoutActivity: true }), "capability-honesty");
    assert.equal(noActivity.status, "failed");
    assert.match(noActivity.reason ?? "", /the native agent has no activity; add it to the harness, or give a reason under capability-honesty\.native-activity/);
    const activityExcused = await runScenario(
      adjustedHarness({ withoutActivity: true, notApplicable: { "capability-honesty.native-activity": "the vendor's server keeps no record of MCP calls" } }),
      "capability-honesty",
    );
    assert.equal(activityExcused.status, "passed", activityExcused.reason);

    const noHistory = await runScenario(adjustedHarness({ withoutInspectSession: true }), "session-replaced");
    assert.equal(noHistory.status, "failed");
    assert.match(noHistory.reason ?? "", /the native agent has no inspectSession; add it to the harness, or give a reason under session-replaced\.native-history/);
    const historyExcused = await runScenario(
      adjustedHarness({ withoutInspectSession: true, notApplicable: { "session-replaced.native-history": "the vendor's sessions cannot be read back" } }),
      "session-replaced",
    );
    assert.equal(historyExcused.status, "passed", historyExcused.reason);
  });

  test("a workspace without a symbolic link fails scenario 11 unless the harness gives a reason", async () => {
    const base = referenceHarness();
    const noLink: ConformanceHarness<ReferenceDriverConfig> = { ...base, workspace: async () => ({ cwd: "/workspace/project" }) };
    const result = await runScenario(noLink, "symlinked-workspace");
    assert.equal(result.status, "failed");
    assert.match(result.reason ?? "", /no symlinkedCwd; give one, or a reason under symlinked-workspace/);
  });
});

describe("a harness's nativeOptionIds mapping", () => {
  /** The reference harness, whose approvals report `mapping` as the native option ids. */
  const mappedHarness = (mapping: (kitIds: readonly string[]) => { [kitId: string]: string }): ConformanceHarness<ReferenceDriverConfig> => {
    const base = referenceHarness();
    return {
      ...base,
      async setup(request) {
        const rig = await base.setup(request);
        const nextTurn = async () => {
          const turn = await rig.native.nextTurn();
          return override(turn, {
            requestApproval: async (approval) => ({ ...(await turn.requestApproval(approval)), nativeOptionIds: mapping(approval.options.map((option) => option.optionId)) }),
          });
        };
        return { ...rig, native: { ...rig.native, nextTurn } };
      },
    };
  };

  test("a one-to-one mapping passes scenario 8", async () => {
    const result = await runScenario(mappedHarness((kitIds) => Object.fromEntries(kitIds.map((id) => [id, id]))), "duplicate-always-options");
    assert.equal(result.status, "passed", result.reason);
  });

  test("a mapping that sends two kit options to one native option fails the scenario, naming both", async () => {
    // The reference driver would pass if the kit trusted this mapping: both accept_always options would find the same native option.
    const result = await runScenario(
      mappedHarness((kitIds) => Object.fromEntries(kitIds.map((id) => [id, id === "allow-session" ? "allow-prefix" : id]))),
      "duplicate-always-options",
    );
    assert.equal(result.status, "failed");
    assert.match(result.reason ?? "", /sends kit options "allow-session" and "allow-prefix" to one native option "allow-prefix"/);
  });
});

describe("scenario 14 accepts honest answers the proposal allows", () => {
  /** The reference harness with some session members replaced. */
  const honestVariation = (name: string, overrides: (session: Session) => Partial<Session>) =>
    brokenHarness(name, { session: (session) => override(session, overrides(session)) });

  test("a context window below the catalog's maximum, and usage that is not reused even for one model name", async () => {
    const result = await runScenario(
      honestVariation("effective limits", () => ({ contextWindow: () => 96_000, canReuseContextUsage: () => false })),
      "capability-honesty",
    );
    assert.equal(result.status, "passed", result.reason);
  });

  test("an unloaded thread that only a fresh session can resume", async () => {
    const result = await runScenario(
      honestVariation("reattach from a fresh session", (session) => {
        // The native handles of threads this session unloaded; this driver reattaches them only from a new session.
        const unloaded = new Set<string>();
        return {
          unloadThread: async (threadId: string) => {
            const { thread } = await session.readSnapshot!(threadId);
            await session.unloadThread!(threadId);
            unloaded.add(thread.handle ?? thread.native.id ?? "");
          },
          resumeThread: async (input: Parameters<Session["resumeThread"]>[0]) => {
            const nativeId = "handle" in input.native ? input.native.handle : input.native.id;
            if (nativeId !== null && unloaded.has(nativeId)) throw callErrors.invalidState("thread_unloaded", "Resume an unloaded thread from a new session");
            return session.resumeThread(input);
          },
        };
      }),
      "capability-honesty",
    );
    assert.equal(result.status, "passed", result.reason);
    assert.ok(result.notes.some((note) => /resumed in a fresh session; the same session refused: invalid_state/.test(note)), result.notes.join("\n"));
  });

  test("a fork from a turn that holds only the turns before it", async () => {
    const result = await runScenario(
      honestVariation("fork before the turn", (session) => ({
        forkThread: async (input: Parameters<NonNullable<Session["forkThread"]>>[0]) => {
          if (input.at.type !== "turn") return session.forkThread!(input);
          const turns = (await session.readSnapshot!(input.threadId)).turns;
          const index = turns.findIndex((turn) => turn.id === (input.at as { turnId: string }).turnId);
          assert.ok(index > 0, "the scenario forks from a turn with history before it");
          return session.forkThread!({ ...input, at: { type: "turn", turnId: turns[index - 1]!.id } });
        },
      })),
      "capability-honesty",
    );
    assert.equal(result.status, "passed", result.reason);
  });
});

describe("the fake host", () => {
  test("records each of the 17 host-service operations by name, in order", async () => {
    const host = createFakeHost({ config: { model: "small" } });
    await host.config.get();
    await host.secrets.get("ns", "key");
    await host.secrets.set("ns", "key", new Uint8Array([1]));
    await host.secrets.delete("ns", "key");
    await host.process.spawn({ command: "agent" }).catch(() => undefined);
    await host.process.resolveExecutable("agent");
    await host.attachments.resolve("ref");
    await host.attachments.extractText?.("ref");
    await host.callbacks.register("flow-1");
    await host.hostTools.mcpServerFor("thread-1", { transport: "stdio" });
    await host.hostTools.callDynamicTool?.({ threadId: "thread-1", callId: "call-1", name: "tool", input: {} });
    await host.background.shouldRun("refresh");
    const lease = await host.coordination.acquire("key", 1000);
    await host.coordination.release(lease!.leaseId);
    host.diagnostics.log({ level: "info", msg: "hello" });
    host.telemetry?.track("event");
    await host.ids?.derive("thread", "native-1");
    assert.deepEqual(
      host.calls.map((call) => call.operation),
      [...HOST_OPERATIONS],
    );
    assert.equal(HOST_OPERATIONS.length, 17);
    const mark = host.mark();
    await host.secrets.get("ns", "other");
    assert.deepEqual(
      host.callsSince(mark).map((call) => [call.operation, call.args]),
      [["secrets.get", ["ns", "other"]]],
    );
  });

  test("spawns with the ambient environment minus stripped names and prefixes, plus explicit additions", async () => {
    let seen: { [name: string]: string } | undefined;
    const host = createFakeHost({
      envPolicy: { stripAmbient: ["VENDOR_*"] },
      ambientEnvironment: { PATH: "/bin", VENDOR_API_KEY: "ambient", VENDOR_TOKEN: "ambient", OTHER: "kept" },
      spawn: async (request) => {
        seen = { ...request.environment };
        return {} as SpawnedProcess;
      },
    });
    assert.deepEqual(host.process.envPolicy, { stripAmbient: ["VENDOR_*"] });
    await host.process.spawn({ command: "agent", env: { VENDOR_API_KEY: "configured" } });
    assert.deepEqual(seen, { PATH: "/bin", OTHER: "kept", VENDOR_API_KEY: "configured" });
    assert.deepEqual(host.spawns[0]?.environment, seen);

    // Without an envPolicy the host strips nothing, credentials included.
    const open = createFakeHost({ ambientEnvironment: { PATH: "/bin", VENDOR_API_KEY: "ambient" }, spawn: async () => ({}) as SpawnedProcess });
    assert.deepEqual(open.process.envPolicy, { stripAmbient: [] });
    await open.process.spawn({ command: "agent" });
    assert.deepEqual(open.spawns[0]?.environment, { PATH: "/bin", VENDOR_API_KEY: "ambient" });

    // inheritEnv: false starts from nothing: the child gets the request's env alone.
    await open.process.spawn({ command: "agent", env: { ONLY: "this" }, inheritEnv: false });
    assert.deepEqual(open.spawns[1]?.environment, { ONLY: "this" });

    const exact = createFakeHost({ envPolicy: { stripAmbient: ["SECRET"] }, ambientEnvironment: { SECRET: "x", SECRET_2: "y" }, spawn: async () => ({}) as SpawnedProcess });
    await exact.process.spawn({ command: "agent" });
    assert.deepEqual(exact.spawns[0]?.environment, { SECRET_2: "y" });
  });

  test("refuses bad secret names, copies secret bytes, and rejects a spawn it cannot perform", async () => {
    const host = createFakeHost({ secrets: [{ namespace: "ns", key: "key", value: "abc" }] });
    for (const [namespace, key] of [
      ["..", "key"],
      ["ns", "a/b"],
      ["", "key"],
    ] as const) {
      await assert.rejects(host.secrets.get(namespace, key), (error: unknown) => isAriError(error, "validation"));
    }
    const value = await host.secrets.get("ns", "key");
    assert.deepEqual([...value!], [97, 98, 99]);
    value![0] = 0;
    assert.deepEqual([...(await host.secrets.get("ns", "key"))!], [97, 98, 99]);
    await assert.rejects(host.process.spawn({ command: "missing" }), (error: unknown) => isAriError(error, "not_found"));
  });

  test("leases are exclusive until released or expired, and config changes reach watchers", async () => {
    const clock = new VirtualClock(Date.UTC(2026, 10, 23));
    clock.install();
    try {
      const host = createFakeHost<{ model: string }>({ config: { model: "small" } });
      const first = await host.coordination.acquire("reset-credit", 30_000);
      assert.ok(first !== null);
      assert.equal(await host.coordination.acquire("reset-credit", 30_000), null);
      clock.advanceBy(30_001);
      const second = await host.coordination.acquire("reset-credit", 30_000);
      assert.ok(second !== null && second.leaseId !== first.leaseId);
      await host.coordination.release(second.leaseId);
      assert.ok((await host.coordination.acquire("reset-credit", 30_000)) !== null);

      const reading = await host.config.get({ watch: true });
      assert.deepEqual(reading.config, { model: "small" });
      host.setConfig({ model: "large" });
      const next = await reading.changes![Symbol.asyncIterator]().next();
      assert.deepEqual(next.value, { model: "large" });
      host.dispose();
    } finally {
      clock.uninstall();
    }
  });
});

describe("virtual time", () => {
  test("replaces timers, Date and performance.now until uninstalled", () => {
    const realSetTimeout = globalThis.setTimeout;
    const RealDate = globalThis.Date;
    const realPerformanceNow = performance.now();
    const clock = new VirtualClock(Date.UTC(2026, 10, 23, 12));
    clock.install();
    try {
      const fired: string[] = [];
      const timeout = setTimeout(() => fired.push("timeout"), 30_000);
      const cancelled = setTimeout(() => fired.push("cancelled"), 10);
      clearTimeout(cancelled);
      let last = Date.now();
      // A quiet timer built from setInterval and Date.now.
      const interval = setInterval(() => {
        if (Date.now() - last >= 30_000) fired.push("quiet");
      }, 1000);
      assert.equal(new Date().toISOString(), "2026-11-23T12:00:00.000Z");
      assert.ok(new Date() instanceof RealDate);
      assert.equal(new Date(0).getTime(), 0);
      clock.advanceBy(29_999);
      assert.deepEqual(fired, []);
      clock.advanceBy(1);
      assert.deepEqual(fired, ["timeout", "quiet"]);
      assert.equal(Date.now(), Date.UTC(2026, 10, 23, 12, 0, 30));
      assert.ok(performance.now() - realPerformanceNow >= 30_000);
      last = Date.now();
      clearInterval(interval);
      clock.advanceBy(60_000);
      assert.deepEqual(fired, ["timeout", "quiet"]);
      void timeout;
    } finally {
      clock.uninstall();
    }
    assert.equal(globalThis.setTimeout, realSetTimeout);
    assert.equal(globalThis.Date, RealDate);
    assert.ok(performance.now() - realPerformanceNow < 30_000);
  });

  test("a harness on real time waits real time", async () => {
    const context = new ScenarioContext({
      harness: { ...referenceHarness(), time: "real" } as ConformanceHarness<unknown>,
      workspace: { cwd: "/workspace/project" },
      scenarioKey: "settlement",
      timeoutMs: 1000,
      suite: { violations: [], streams: 0 },
    });
    const started = Date.now();
    const mode = await context.withClock(async (clock) => {
      await clock.pass(40);
      return clock.mode;
    });
    assert.equal(mode, "real");
    assert.ok(Date.now() - started >= 30, `waited ${Date.now() - started} ms`);
  });
});

describe("the node:test adapter", () => {
  test("fails a failed scenario's subtest, skips a not-applicable one with its reason, and reports notes", async () => {
    const events: string[] = [];
    const context = (name: string): NodeTestContext => ({
      test: async (child, fn) => {
        try {
          await fn(context(child));
          events.push(`pass ${child}`);
        } catch (error) {
          events.push(`fail ${child}: ${(error as Error).message}`);
        }
      },
      skip: (message) => events.push(`skip ${name}: ${message ?? ""}`),
      diagnostic: (message) => events.push(`note ${name}: ${message}`),
    });
    let registered: Promise<void> | undefined;
    conformanceTests(
      (name, fn) => {
        events.push(`register ${name}`);
        registered = fn(context(name));
      },
      adjustedHarness({ withoutLockSession: true, notApplicable: { "turn-interrupted": "the agent cannot be stopped" } }),
      { scenarios: ["turn-interrupted", "session-replaced"], timeoutMs: 1500 },
    );
    await registered;
    assert.equal(events[0], "register ARI conformance: reference driver (full, in memory)");
    assert.ok(events.includes("skip scenario 3 (turn-interrupted): A turn ends by interrupt (Stop): not applicable (harness): the agent cannot be stopped"), events.join("\n"));
    assert.ok(events.some((event) => /^fail scenario 9 \(session-replaced\).*failed: the harness's native agent has no lockSession/.test(event)), events.join("\n"));
  });

  test("where node:test cannot nest tests (Bun's ERR_NOT_IMPLEMENTED), every scenario runs in the harness's test and its failures fail that test", async () => {
    const events: string[] = [];
    const notImplemented = (what: string): never => {
      throw Object.assign(new Error(`${what} inside another test() is not yet implemented`), { code: "ERR_NOT_IMPLEMENTED" });
    };
    const context: NodeTestContext = {
      test: () => notImplemented("test()"),
      skip: () => notImplemented("skip()"),
      diagnostic: (message) => events.push(`note ${message}`),
    };
    let registered: Promise<void> | undefined;
    let report: ConformanceReport | undefined;
    conformanceTests(
      (name, fn) => {
        events.push(`register ${name}`);
        registered = fn(context);
      },
      adjustedHarness({ withoutLockSession: true, notApplicable: { "turn-interrupted": "the agent cannot be stopped" } }),
      { scenarios: ["turn-completed", "turn-interrupted", "session-replaced"], timeoutMs: 1500, onReport: (value) => void (report = value) },
    );
    const failure = await registered!.then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    assert.ok(failure instanceof Error, "the harness's test must fail when a scenario fails");
    assert.match(failure.message, /^scenario 9 \(session-replaced\) failed: the harness's native agent has no lockSession/);
    assert.deepEqual(
      report?.results.map((result) => [result.id, result.status]),
      [
        [2, "passed"],
        [3, "not_applicable"],
        [9, "failed"],
      ],
    );
    assert.equal(report?.passed, false);
    assert.ok(events.includes("note scenario 3 (turn-interrupted): A turn ends by interrupt (Stop): skipped, not applicable (harness): the agent cannot be stopped"), events.join("\n"));
  });
});

describe("the gated-member table", () => {
  test("covers every capability-gated Session member of methods.json", () => {
    const methods = JSON.parse(fs.readFileSync(path.join(root, "spec/v1/methods.json"), "utf8")) as {
      methods: Array<{ interface?: string; member?: string; capability?: string }>;
    };
    const gated = methods.methods.filter((entry) => entry.interface === "Session" && entry.capability !== undefined);
    assert.ok(gated.length >= 15);
    for (const entry of gated) {
      const row = GATED_MEMBERS.find((candidate) => candidate.member === entry.member);
      assert.ok(row !== undefined, `methods.json gates ${entry.member} by ${entry.capability}, which scenario 14 does not check`);
      assert.ok(row.capabilities.includes(entry.capability!), `${entry.member}: ${entry.capability} missing from ${row.capabilities.join(", ")}`);
    }
    // The two gates the capability guard adds beyond methods.json.
    assert.deepEqual(GATED_MEMBERS.find((row) => row.member === "release")?.capabilities, ["sessions.release"]);
    assert.ok(GATED_MEMBERS.find((row) => row.member === "rollbackThread")?.capabilities.includes("checkpointing.conversationRollback"));
  });
});

describe("virtual time follows real time and Node's timer handles", () => {
  test("refresh() restarts a pending timer and runs a timer that already fired again; a cleared timer stays cleared", () => {
    const clock = new VirtualClock(Date.UTC(2026, 10, 23));
    clock.install();
    try {
      const fired: number[] = [];
      const timer = setTimeout(() => fired.push(Date.now()), 30_000);
      clock.advanceBy(20_000);
      timer.refresh();
      clock.advanceBy(20_000);
      assert.deepEqual(fired, []);
      clock.advanceBy(10_000);
      assert.deepEqual(fired, [Date.UTC(2026, 10, 23, 0, 0, 50)]);
      timer.refresh();
      clock.advanceBy(30_000);
      assert.equal(fired.length, 2);
      clearTimeout(timer);
      timer.refresh();
      clock.advanceBy(60_000);
      assert.equal(fired.length, 2);
    } finally {
      clock.uninstall();
    }
  });

  test("followRealTime runs a short timer once that much real time has passed, without the kit moving the clock", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const clock = new VirtualClock();
    clock.install();
    try {
      let fired = false;
      setTimeout(() => {
        fired = true;
      }, 20);
      clock.followRealTime();
      assert.equal(fired, false);
      await new Promise((resolve) => realSetTimeout(resolve, 40));
      clock.followRealTime();
      assert.equal(fired, true);
    } finally {
      clock.uninstall();
    }
  });
});

describe("virtual time and real timers", () => {
  test("clearing a timer made before virtual time was installed clears the real timer", async () => {
    let fired = false;
    const real = setTimeout(() => {
      fired = true;
    }, 20);
    const clock = new VirtualClock();
    clock.install();
    try {
      const virtual = setTimeout(() => undefined, 5);
      clearTimeout(real);
      assert.equal(clock.pendingTimers, 1, "clearing the real timer must not cancel a virtual one");
      clearTimeout(virtual);
      assert.equal(clock.pendingTimers, 0);
    } finally {
      clock.uninstall();
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(fired, false);
  });
});
