// What the tests that kill an agent's owner record and check: each agent's
// pid, its grandchild's pid, its process group and its guard (the
// `/bin/sh -c … ari-agent-guard <group id> <grace ms>` process ari/node starts
// beside it). "Gone" means `kill(pid, 0)`, or `kill(-group, 0)` for a group,
// fails with ESRCH. Every helper acts only on the pids and groups a test
// recorded. Linux reads /proc; macOS asks `ps`.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const hasProc = existsSync("/proc/self/stat");

/** False once `kill(pid, 0)` fails with ESRCH. A zombie still counts as running. */
export function isRunning(pid: number): boolean {
  return signalExists(pid);
}

/** False once `kill(-groupId, 0)` fails with ESRCH: no process, zombie or not, is left in the group. */
export function groupExists(groupId: number): boolean {
  return signalExists(-groupId);
}

function signalExists(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

/** The process group of `pid`. */
export function processGroupOf(pid: number): number {
  if (hasProc) {
    // /proc/<pid>/stat is "pid (comm) state ppid pgrp ..."; comm may hold spaces and parentheses.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(fields[2]);
  }
  return Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim());
}

/** The pids of the direct children of `parent` whose command name is `name` (such as `sleep`). */
export function childrenNamed(parent: number, name: string): number[] {
  if (hasProc) {
    return readdirSync("/proc").flatMap((entry) => {
      if (!/^\d+$/.test(entry)) return [];
      try {
        // /proc/<pid>/stat is "pid (comm) state ppid ...".
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        return ppid === parent && comm === name ? [Number(entry)] : [];
      } catch {
        return []; // The process ended while being read.
      }
    });
  }
  return execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return match !== null && Number(match[2]) === parent && match[3]!.trim().split("/").pop() === name ? [Number(match[1])] : [];
    });
}

/** The pids of the guards in process group `groupId`: its members that run `/bin/sh -c … ari-agent-guard …`. */
export function guardsOf(groupId: number): number[] {
  if (hasProc) {
    const guards: number[] = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      let argv: string[];
      try {
        argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
        if (argv[0] !== "/bin/sh" || argv[1] !== "-c" || argv[3] !== "ari-agent-guard") continue;
        if (processGroupOf(Number(entry)) === groupId) guards.push(Number(entry));
      } catch {
        continue; // The process ended while being read.
      }
    }
    return guards;
  }
  return execFileSync("ps", ["-ww", "-A", "-o", "pid=,pgid=,args="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+\/bin\/sh -c .* ari-agent-guard \d+ /.exec(line);
      return match !== null && Number(match[2]) === groupId ? [Number(match[1])] : [];
    });
}

/** Whether `pid` is stopped (SIGSTOP), from /proc or `ps`. */
export function isStopped(pid: number): boolean {
  if (hasProc) {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("T");
  }
  return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("T");
}

export interface RecordedAgent {
  readonly pid: number;
  /** Undefined for a launcher paused before its agent ran: its grandchild, if it ever starts, is in the group. */
  readonly grandchildPid: number | undefined;
  readonly groupId: number;
  readonly guardPids: readonly number[];
}

/**
 * Adds every reported agent to `agents`, then checks each: it leads its own
 * group, its grandchild is in that group, and exactly one guard watches it.
 * All are added before any check, so `killRecorded(agents)` cleans them up
 * even when a check fails.
 */
export function recordAgents(agents: RecordedAgent[], reported: ReadonlyArray<{ readonly pid: number; readonly grandchildPid: number }>): RecordedAgent[] {
  const added: RecordedAgent[] = [];
  for (const { pid, grandchildPid } of reported) {
    assert.ok(Number.isInteger(pid) && pid > 0, `agent pid ${pid}`);
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, `grandchild pid ${grandchildPid}`);
    const groupId = processGroupOf(pid);
    const agent: RecordedAgent = { pid, grandchildPid, groupId, guardPids: guardsOf(groupId) };
    agents.push(agent);
    added.push(agent);
  }
  for (const agent of added) {
    assert.equal(agent.groupId, agent.pid, "the agent leads its own process group");
    assert.equal(processGroupOf(agent.grandchildPid!), agent.groupId, "the grandchild is in the agent's process group");
    assert.equal(agent.guardPids.length, 1, `exactly one guard is in group ${agent.groupId}: ${JSON.stringify(agent.guardPids)}`);
  }
  return added;
}

/**
 * Adds a launcher stopped right after its spawn, before its guard exists, to
 * `agents`, then checks that it leads its own group, that it is stopped, and
 * that no guard is in its group yet: the window between an agent's spawn and
 * its guard. The group check later covers whatever the launcher starts.
 */
export function recordPausedLauncher(agents: RecordedAgent[], pid: number): RecordedAgent {
  assert.ok(Number.isInteger(pid) && pid > 0, `launcher pid ${pid}`);
  const agent: RecordedAgent = { pid, grandchildPid: undefined, groupId: processGroupOf(pid), guardPids: [] };
  agents.push(agent);
  assert.equal(agent.groupId, pid, "the launcher leads its own process group");
  assert.equal(isStopped(pid), true, "the launcher is stopped right after its spawn");
  assert.deepEqual(guardsOf(pid), [], "no guard is in the launcher's group yet");
  return agent;
}

/** Descriptions of what is still running of `agents`: agents, grandchildren, groups and guards. */
export function survivorsOf(agents: readonly RecordedAgent[]): string[] {
  const left: string[] = [];
  for (const agent of agents) {
    if (isRunning(agent.pid)) left.push(`agent ${agent.pid}`);
    if (agent.grandchildPid !== undefined && isRunning(agent.grandchildPid)) left.push(`grandchild ${agent.grandchildPid}`);
    if (groupExists(agent.groupId)) left.push(`group ${agent.groupId}`);
    for (const guard of agent.guardPids) if (isRunning(guard)) left.push(`guard ${guard}`);
  }
  return left;
}

/**
 * Samples `agents` until nothing of them runs, or `deadline` (a `Date.now()`
 * value) passes, and returns what still ran at the last sample. Start it
 * right after the event the deadline counts from. Only a sample finished by
 * the deadline proves anything: when the first empty sample finishes later,
 * the result says so instead of being empty.
 */
export async function survivorsAt(agents: readonly RecordedAgent[], deadline: number): Promise<string[]> {
  for (;;) {
    const left = survivorsOf(agents);
    const sampledBy = Date.now();
    if (left.length === 0) return sampledBy <= deadline ? [] : [`nothing was left, but the first sample to show it finished ${sampledBy - deadline} ms after the deadline`];
    if (sampledBy >= deadline) return left;
    await delay(10);
  }
}

/** Test cleanup: SIGKILL whatever of `agents` still runs (their groups and guards), by the ids the test recorded. */
export function killRecorded(agents: readonly RecordedAgent[]): void {
  for (const agent of agents) {
    // Signal the group only when the agent leads it; any other group could hold this test's own process.
    const members = agent.groupId === agent.pid ? [-agent.groupId] : [agent.pid, ...(agent.grandchildPid === undefined ? [] : [agent.grandchildPid])];
    for (const target of [...members, ...agent.guardPids]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
}
