// Scenarios 10 and 12: the five auth states with runtime auth poison and
// dropped inherited credentials, and side-effect-free probes.

import type { AuthState, ProbeResult } from "../../generated/instance.ts";
import { ProbeResultSchema } from "../../generated/instance.ts";
import type { CreatedInstance, ScenarioContext } from "../context.ts";
import type { FakeSpawnRequest, HostCall } from "../fake-host.ts";
import type { AmbientAuthArrangement, HarnessRig, InstanceFileWatch } from "../harness.ts";
import { baseName, brief, sameJson } from "../util.ts";
import { describeError } from "./sessions.ts";
import type { Scenario } from "./scenario.ts";

/** A runtime auth poison longer than this is not the short-lived override the contract describes. */
const LONGEST_POISON_MS = 10 * 60 * 1000;

function authOf(context: ScenarioContext, created: CreatedInstance): NonNullable<CreatedInstance["instance"]["auth"]> {
  const auth = created.instance.auth;
  if (auth === undefined) context.notApplicableByAbsence("Instance.auth");
  return auth;
}

/** Sends one turn and fails when sign-in state blocked it. */
async function checkSendWorks(context: ScenarioContext, rig: HarnessRig<unknown>, created: CreatedInstance, status: string): Promise<void> {
  let opened;
  try {
    opened = await context.openSession(created);
  } catch (error) {
    context.fail(`auth state ${status} blocked Send: openSession rejected with ${describeError(error)}`);
  }
  const thread = await context.createThread(opened);
  const result = await context.startTurn(opened, thread.id, "Hello.");
  context.check(result.status === "accepted", `auth state ${status} blocked Send: startTurn returned ${brief(result)}`);
  const native = await context.wait(rig.native.nextTurn(), "the native agent to receive the prompt");
  await context.wait(native.complete(), "the native agent to complete the turn");
  const terminal = await context.terminal(opened, result.turnId);
  context.check(terminal.status === "completed", `a turn under auth state ${status} ended ${brief(terminal.status)}`);
  await opened.close();
}

async function checkState(context: ScenarioContext, ambientAuth: AmbientAuthArrangement, managedProfile: boolean, expected: string): Promise<{ rig: HarnessRig<unknown>; created: CreatedInstance; state: AuthState }> {
  const rig = await context.rig({ ambientAuth });
  const created = await context.instance(rig, { managedProfile });
  const state = await context.wait(authOf(context, created).state(), "auth.state()");
  const arrangement = managedProfile ? `a stored, unchecked managed credential (ambient account ${ambientAuth})` : `an ambient account whose check is ${ambientAuth}`;
  context.check(state.status === expected, `with ${arrangement}, auth.state() reports ${brief(state.status)}; expected ${brief(expected)}`);
  return { rig, created, state };
}

function environmentLeaks(environment: { readonly [name: string]: string }, markers: ReadonlyMap<string, string>): string[] {
  const leaks: string[] = [];
  for (const [name, value] of Object.entries(environment)) {
    for (const [credential, marker] of markers) {
      if (value.includes(marker)) leaks.push(`${credential} (as ${name})`);
    }
  }
  return leaks;
}

function spawnLeaks(spawn: FakeSpawnRequest, markers: ReadonlyMap<string, string>): string[] {
  const leaks = environmentLeaks(spawn.environment, markers);
  for (const argument of spawn.args ?? []) {
    for (const [credential, marker] of markers) {
      if (argument.includes(marker)) leaks.push(`${credential} (in an argument)`);
    }
  }
  return leaks;
}

async function checkInheritedCredentialsDropped(context: ScenarioContext): Promise<void> {
  const rig = await context.rig({ ambientAuth: "authenticated" });
  const names = rig.inheritedCredentials ?? [];
  if (names.length === 0) {
    context.fail("the rig declares no inheritedCredentials; name the provider's credential variables, or give a reason under auth-states.inherited-credentials");
  }
  const markers = new Map(names.map((name) => [name, `ari-conformance-inherited-${name.toLowerCase()}`] as const));
  const values = Object.fromEntries(markers);
  const processEnvironment = (globalThis as { process?: { env?: { [name: string]: string | undefined } } }).process?.env;
  const saved = new Map(names.map((name) => [name, processEnvironment?.[name]] as const));
  if (processEnvironment !== undefined) Object.assign(processEnvironment, values);
  try {
    const created = await context.instance(rig, { environment: values, ambientEnvironment: values });
    await context.wait(created.instance.status(), "status()");
    await context.wait(created.instance.probe(), "probe()");
    await context.wait(authOf(context, created).state(), "auth.state()");
    const opened = await context.openSession(created);
    const thread = await context.createThread(opened);
    await context.simpleTurn(opened, rig, thread.id, "Hello.");
    await opened.close();

    const observed = (await rig.native.observedEnvironments?.()) ?? [];
    if (created.host.spawns.length === 0 && rig.native.observedEnvironments === undefined) {
      context.fail(
        "the driver spawned nothing through the host and the harness reports no native environment, so dropped credentials cannot be checked; add NativeAgent.observedEnvironments, or give a reason under auth-states.inherited-credentials",
      );
    }
    for (const spawn of created.host.spawns) {
      const leaks = spawnLeaks(spawn, markers);
      context.check(leaks.length === 0, `inherited credentials reached ${spawn.command}: ${leaks.join(", ")}; drop credentials the instance did not configure`);
    }
    for (const environment of observed) {
      const leaks = environmentLeaks(environment, markers);
      context.check(leaks.length === 0, `inherited credentials reached the native runtime: ${leaks.join(", ")}; drop credentials the instance did not configure`);
    }
    context.note(`inherited ${names.join(", ")} checked across ${created.host.spawns.length} spawn(s) and ${observed.length} native environment(s)`);
  } finally {
    if (processEnvironment !== undefined) {
      for (const [name, value] of saved) {
        if (value === undefined) delete processEnvironment[name];
        else processEnvironment[name] = value;
      }
    }
  }
}

async function checkRuntimePoison(context: ScenarioContext): Promise<void> {
  // The clock goes in first, so a timer the driver makes for the poison (or for anything else) is on it.
  await context.withClock(async (clock) => {
    const rig = await context.rig({ ambientAuth: "authenticated" });
    const managed = await context.instance(rig, { managedProfile: true });
    const ambient = await context.instance(rig, { managedProfile: false });
    const managedAuth = authOf(context, managed);
    const ambientAuth = authOf(context, ambient);
    if (managedAuth.reportRuntimeFailure === undefined) {
      context.note("runtime auth poison not checked: the driver leaves out the optional member Instance.auth.reportRuntimeFailure");
      return;
    }
    const report = managedAuth.reportRuntimeFailure.bind(managedAuth);
    const managedBefore = await context.wait(managedAuth.state(), "auth.state() of the managed instance before the failure");
    const ambientBefore = await context.wait(ambientAuth.state(), "auth.state() of the ambient instance");

    const poisoned = await context.wait(report({ code: "401", message: "The provider rejected the credentials." }), "auth.reportRuntimeFailure()");
    context.check(poisoned.evidence === "runtime_poison", `after a runtime auth failure, auth state evidence is ${brief(poisoned.evidence)}; expected "runtime_poison"`);
    context.check(poisoned.status === "unauthenticated", `a runtime auth poison reports status ${brief(poisoned.status)}; expected "unauthenticated"`);
    context.check(poisoned.scope === managedBefore.scope, `the runtime auth poison names scope ${brief(poisoned.scope)}; the failure was in scope ${brief(managedBefore.scope)}`);
    const expiresAt = poisoned.poisonExpiresAt === undefined ? Number.NaN : Date.parse(poisoned.poisonExpiresAt);
    context.check(Number.isFinite(expiresAt) && expiresAt > clock.now(), `a runtime auth poison needs a future poisonExpiresAt; got ${brief(poisoned.poisonExpiresAt)}`);
    const ttl = expiresAt - clock.now();
    context.check(ttl <= LONGEST_POISON_MS, `the runtime auth poison lasts ${Math.round(ttl / 1000)} s; it must be short-lived`);
    const stillPoisoned = await context.wait(managedAuth.state(), "auth.state() of the poisoned instance");
    context.check(stillPoisoned.evidence === "runtime_poison", `auth.state() right after the runtime failure reports evidence ${brief(stillPoisoned.evidence)}; expected "runtime_poison"`);
    context.check(stillPoisoned.scope === managedBefore.scope, `auth.state() right after the runtime failure names scope ${brief(stillPoisoned.scope)}; the failure was in scope ${brief(managedBefore.scope)}`);
    const ambientAfter = await context.wait(ambientAuth.state(), "auth.state() of the ambient instance");
    context.check(
      sameJson(ambientBefore, ambientAfter),
      `a runtime auth failure of the managed profile changed the ambient instance's auth state from ${brief(ambientBefore)} to ${brief(ambientAfter)}`,
    );

    // After the advertised expiry the instance is back where it was: the same verdict, and Send works.
    await clock.pass(ttl + 1000);
    const expired = await context.wait(managedAuth.state(), "auth.state() after the poison expired");
    context.check(expired.evidence !== "runtime_poison", `auth.state() still reports runtime_poison ${Math.round((ttl + 1000) / 1000)} s later, after poisonExpiresAt`);
    context.check(
      expired.status === managedBefore.status && expired.scope === managedBefore.scope,
      `after the runtime auth poison expired, auth.state() reports ${brief(expired.status)} in scope ${brief(expired.scope)}; before the failure it was ${brief(managedBefore.status)} in scope ${brief(managedBefore.scope)}`,
    );
    await checkSendWorks(context, rig, managed, `${managedBefore.status} (after the runtime auth poison expired)`);
    context.note(`the runtime auth poison lasted ${Math.round(ttl / 1000)} s of ${clock.mode} time`);
  });
}

export const authStatesScenario: Scenario = {
  id: 10,
  key: "auth-states",
  title:
    "Five-state auth: configured and unavailable never block Send; a runtime auth failure poisons only its own scope and expires; unknown sign-in is reported unknown; inherited credentials are dropped",
  async run(context: ScenarioContext) {
    // Declared by presence: a driver without sign-in leaves `auth` out.
    {
      const rig = await context.rig({ ambientAuth: "authenticated" });
      authOf(context, await context.instance(rig));
    }
    if (!context.skipCheck("auth-states.configured", "a configured credential")) {
      const { rig, created } = await checkState(context, "unauthenticated", true, "configured");
      await checkSendWorks(context, rig, created, "configured");
    }
    if (!context.skipCheck("auth-states.unavailable", "an unavailable sign-in check")) {
      const { rig, created } = await checkState(context, "unavailable", false, "unavailable");
      await checkSendWorks(context, rig, created, "unavailable");
    }
    if (!context.skipCheck("auth-states.unknown", "an unknown sign-in")) {
      await checkState(context, "unknown", false, "unknown");
    }
    if (!context.skipCheck("auth-states.poison", "runtime auth poison")) {
      await checkRuntimePoison(context);
    }
    if (!context.skipCheck("auth-states.inherited-credentials", "dropping inherited credentials")) {
      await checkInheritedCredentialsDropped(context);
    }
  },
};

/** Host operations a probe must never call. */
export const MUTATING_HOST_OPERATIONS: ReadonlySet<string> = new Set([
  "secrets.set",
  "secrets.delete",
  "callbacks.register",
  "coordination.acquire",
  "hostTools.mcpServerFor",
  "hostTools.callDynamicTool",
]);

function describeCall(call: HostCall): string {
  if (call.operation === "process.spawn") {
    const request = call.args[0] as FakeSpawnRequest;
    return `process.spawn of ${[request.command, ...(request.args ?? [])].join(" ")}`;
  }
  return `${call.operation}(${brief(call.args, 120)})`;
}

export const sideEffectFreeProbeScenario: Scenario = {
  id: 12,
  key: "side-effect-free-probe",
  title: "probe() makes no mutating host-service call and writes no file under the instance's paths",
  async run(context: ScenarioContext) {
    const rig = await context.rig();
    const created = await context.instance(rig);
    const allowed = new Set((rig.probeExecutables ?? (rig.driver.cliManifest === undefined ? [] : [rig.driver.cliManifest.binary])).map(baseName));
    const watchFiles = rig.watchInstanceFiles?.bind(rig);
    let watch: InstanceFileWatch | undefined;
    if (watchFiles === undefined) {
      if (!context.skipCheck("side-effect-free-probe.files", "files written under the instance's paths")) {
        context.fail("the rig cannot watch the files under an instance's paths; add watchInstanceFiles, or give a reason under side-effect-free-probe.files");
      }
    } else {
      watch = await context.wait(watchFiles(created.host.paths), "the harness to start watching the instance's files");
    }

    // The watch runs for the whole of both calls, so a file written and removed again before probe() returns still shows.
    const mark = created.host.mark();
    const results: ProbeResult[] = [];
    let written: readonly string[] = [];
    try {
      results.push(await context.wait(created.instance.probe(), "probe()"));
      results.push(await context.wait(created.instance.probe({ deep: true }), "probe({ deep: true })"));
    } finally {
      if (watch !== undefined) written = await context.wait(watch.stop(), "the harness to stop watching the instance's files");
    }
    for (const result of results) context.check(ProbeResultSchema.is(result), `probe() returned an invalid ProbeResult: ${brief(result)}`);

    const calls = created.host.callsSince(mark);
    const mutating = calls.filter((call) => {
      if (MUTATING_HOST_OPERATIONS.has(call.operation)) return true;
      if (call.operation !== "process.spawn") return false;
      return !allowed.has(baseName((call.args[0] as FakeSpawnRequest).command));
    });
    context.check(
      mutating.length === 0,
      `probe() made mutating host calls: ${mutating.map(describeCall).join("; ")}${allowed.size === 0 ? "" : ` (probe executables: ${[...allowed].join(", ")})`}`,
    );
    context.check(written.length === 0, `probe() wrote files under the instance's paths: ${written.join(", ")}`);
    context.note(`probe() made ${calls.length} host call(s): ${[...new Set(calls.map((call) => call.operation))].join(", ") || "none"}`);
  },
};
