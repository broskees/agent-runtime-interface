// The frames of a stdio recording: the traffic between an ARI driver and an
// agent process it starts through `HostServices.process`. The process tap
// (./tap.ts) writes them and the replay process service (./replay-process.ts)
// plays them back. They know nothing of the protocol on the pipes: a line is
// kept as parsed JSON when it is JSON, else as text, so ACP, Codex app-server
// and any other line protocol record the same way.
//
// Every frame names its process by `proc`: 1, 2, ... in the order the driver
// asked the host to spawn them. docs/recordings.md, "Stdio frames", lists the
// kinds; test/recordings/docs.test.ts checks that list against this one.

import type { Frame, FrameDirection } from "../format.ts";

export const STDIO_FRAME_KINDS: ReadonlyArray<{ readonly dir: FrameDirection; readonly kind: string }> = [
  { dir: "out", kind: "spawn" },
  { dir: "in", kind: "spawn_failed" },
  { dir: "out", kind: "stdin" },
  { dir: "out", kind: "close_stdin" },
  { dir: "out", kind: "kill" },
  { dir: "in", kind: "stdout" },
  { dir: "in", kind: "stderr" },
  { dir: "in", kind: "exit" },
];

/** Splits a byte or text stream into lines, as they complete. A "\n" ends a line; the line keeps everything before it, a "\r" included. */
export class LineSplitter {
  readonly #decoder = new TextDecoder("utf-8");
  #partial = "";

  /** The lines `chunk` completes. */
  push(chunk: Uint8Array | string): string[] {
    const text = this.#partial + (typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true }));
    const lines = text.split("\n");
    this.#partial = lines.pop()!;
    return lines;
  }

  /** The text after the last line feed, when the stream ended; "" when there is none. */
  end(): string {
    const rest = this.#partial + this.#decoder.decode();
    this.#partial = "";
    return rest;
  }
}

/**
 * The frame for one line on a pipe of process `proc`. A `stdin` or `stdout`
 * line that is JSON is kept parsed, as `message`; any other line, and every
 * `stderr` line, as `text`. `newline: false` marks the text a stream held
 * after its last line feed when it ended.
 */
export function lineFrame(dir: FrameDirection, kind: "stdin" | "stdout" | "stderr", proc: number, line: string, ended = false): Frame {
  const tail = ended ? { newline: false } : {};
  if (kind !== "stderr" && line.trim() !== "") {
    try {
      return { dir, kind, proc, message: JSON.parse(line) as unknown, ...tail };
    } catch {
      // Not JSON: kept as text.
    }
  }
  return { dir, kind, proc, text: line, ...tail };
}

/** The bytes a recorded line frame stands for, as replay hands them to the driver: the JSON or the text, then a line feed unless the stream ended without one. */
export function lineText(frame: Frame): string {
  const body = "message" in frame ? JSON.stringify(frame["message"]) : String(frame["text"] ?? "");
  return frame["newline"] === false ? body : `${body}\n`;
}

/** The `proc` of a stdio frame. */
export function procOf(frame: Frame): number {
  return Number(frame["proc"]);
}
