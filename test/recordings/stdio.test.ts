// The process tap and the replay process service on their own, with a process
// double that speaks no protocol, so what is proven here holds for every stdio
// driver (Antigravity's ACP, Codex's app-server). A driver may drain a pipe
// apart from waiting for the process's exit, as an ACP driver drains stderr:
// it can then start the next process before it reads the first one's last
// line. The tap records that order, and replay plays its own tape back.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProcessExit, SpawnRequest } from "../../src/generated/host.ts";
import type { HostServices, SpawnedProcess } from "../../src/runtime.ts";
import { encodeRecording, parseRecording } from "./format.ts";
import type { Frame } from "./format.ts";
import { createSanitiser } from "./sanitiser.ts";
import { startStdioReplay } from "./stdio/replay-process.ts";
import { tapProcess } from "./stdio/tap.ts";

type ProcessService = HostServices["process"];

/** One output pipe of a process double: the test pushes text into it and ends it. */
class DoublePipe implements AsyncIterable<Uint8Array> {
  readonly #chunks: Uint8Array[] = [];
  #ended = false;
  #wake: (() => void) | undefined;

  push(text: string): void {
    this.#chunks.push(new TextEncoder().encode(text));
    this.#wake?.();
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (;;) {
      const chunk = this.#chunks.shift();
      if (chunk !== undefined) {
        yield chunk;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((resolve) => (this.#wake = resolve));
      this.#wake = undefined;
    }
  }
}

/**
 * A process service whose processes answer each stdin line with one stdout
 * line, then end stdout and exit. The first process keeps its stderr open
 * past its exit, and writes its last stderr line, with no line feed, and
 * ends it only when the second process starts.
 */
function processDouble(): ProcessService {
  const stderrs: DoublePipe[] = [];
  return {
    envPolicy: { stripAmbient: [] },
    resolveExecutable: async (name) => name,
    spawn: async (_request: SpawnRequest): Promise<SpawnedProcess> => {
      const number = stderrs.length + 1;
      const stdout = new DoublePipe();
      const stderr = new DoublePipe();
      stderrs.push(stderr);
      if (number === 2) {
        stderrs[0]!.push("first: last words");
        stderrs[0]!.end();
      }
      let exit!: (value: ProcessExit) => void;
      const exited = new Promise<ProcessExit>((resolve) => (exit = resolve));
      return {
        stdout,
        stderr,
        exited,
        write: async (data) => {
          stdout.push(`${JSON.stringify({ answer: number, to: JSON.parse(String(data)) as unknown })}\n`);
          stderr.push(`process ${number}: answered\n`);
          stdout.end();
          if (number === 2) stderr.end();
          exit({ code: 0, signal: null });
        },
        closeStdin: async () => undefined,
        kill: async () => undefined,
      };
    },
  };
}

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

/**
 * A driver that drains each process's stderr apart from its stdout and its
 * exit: it waits for the first process's stdout and exit, starts the second
 * process, and only then waits for the first one's stderr to end.
 */
async function drive(service: ProcessService): Promise<{ stdout: string[]; stderr: string[] }> {
  const first = await service.spawn({ command: "double", args: ["first"], purpose: "runtime", stdin: "pipe" });
  const firstStderr = readAll(first.stderr);
  const firstStdout = readAll(first.stdout);
  await first.write(`${JSON.stringify({ ask: 1 })}\n`);
  const firstOut = await firstStdout;
  await first.exited;
  const second = await service.spawn({ command: "double", args: ["second"], purpose: "runtime", stdin: "pipe" });
  const firstErr = await firstStderr;
  const secondStderr = readAll(second.stderr);
  const secondStdout = readAll(second.stdout);
  await second.write(`${JSON.stringify({ ask: 2 })}\n`);
  const secondOut = await secondStdout;
  await second.exited;
  return { stdout: [firstOut, secondOut], stderr: [firstErr, await secondStderr] };
}

test("a process's last stderr line that the driver takes after it started the next process is recorded there, and replay keeps the pipe open until that line and plays its own tape back", async () => {
  const frames: Frame[] = [];
  const tap = tapProcess(processDouble(), (frame) => frames.push(frame));
  const recorded = await drive(tap.process);
  assert.ok(await tap.settled(5_000));
  assert.deepEqual(recorded.stderr, ["process 1: answered\nfirst: last words", "process 2: answered\n"]);

  // The tap kept the order the driver took the lines in: the first process's last stderr line comes after the second spawn.
  const tail = frames.findIndex((frame) => frame.kind === "stderr" && frame["proc"] === 1 && frame["newline"] === false);
  const secondSpawn = frames.findIndex((frame) => frame.kind === "spawn" && frame["proc"] === 2);
  const firstExit = frames.findIndex((frame) => frame.kind === "exit" && frame["proc"] === 1);
  assert.ok(firstExit !== -1 && secondSpawn > firstExit && tail > secondSpawn, JSON.stringify(frames));
  assert.deepEqual(frames[tail], { dir: "in", kind: "stderr", proc: 1, text: "first: last words", newline: false });
  assert.ok(frames.slice(tail + 1).some((frame) => frame.kind === "stdin" && frame["proc"] === 2), "the driver wrote to the second process after it took the first one's last line");

  const recording = parseRecording(
    encodeRecording({ driver: "double", vendor: "double", vendorVersion: "0", sdk: "none", sdkVersion: "0", model: "none", scenario: "simple", recorded: "2026-11-25", source: "fake" }, frames),
    "double.ndjson",
  );
  const replay = startStdioReplay(recording, { workspace: "/nonexistent-ari-workspace", sanitise: createSanitiser({ workspace: "/nonexistent-ari-workspace", env: {}, user: "ari-nobody" }), ignored: [], envPolicy: { stripAmbient: [] } });
  const replayed = await drive(replay.process);
  assert.equal(replay.sequencer.failure, undefined, replay.sequencer.failure?.message);
  assert.equal(await replay.sequencer.whenTaken(500), true);
  replay.sequencer.finish();
  assert.ok(replay.sequencer.done());
  assert.deepEqual(replayed, recorded, "the driver read on replay what it read when recording");
});
