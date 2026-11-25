// A fake `agy` on PATH for the Antigravity recorder's tests: a directory with
// an `agy` script that runs ./fake-agy-cli.ts, and the files the fake reports
// to. The recorder passes its own environment on to `agy` (less HOME, the XDG
// directories, TMPDIR and the session bus), so the fake's ARI_FAKE_AGY_*
// variables reach it from the recorder's environment.

import * as fs from "node:fs";
import * as path from "node:path";
import { NODE_EXECUTABLE } from "../../helpers/runtime.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";

/** What the fake `agy` prints for `--version`. */
export const FAKE_AGY_VERSION = "1.5.17-fake";

/** The fake's model option values when ARI_FAKE_AGY_MODELS is not set: a Pro model first (the current one), then two Flash models. */
export const FAKE_AGY_MODELS = [
  { value: "fake-pro-high", name: "Fake Pro (High)" },
  { value: "fake-flash", name: "Fake Flash" },
  { value: "fake-flash-lite", name: "Fake Flash Lite" },
];

/** What one fake `agy` process saw when it started, and, for `acp`, what it loaded and the sign-in it found. */
export interface FakeAgyProcess {
  readonly args: string[];
  readonly env: { [name: string]: string };
  readonly cwd: string;
  readonly loaded?: string[];
  readonly signIn?: string | null;
  readonly signInFile?: string;
}

export interface FakeAgy {
  /** The directory to put first on PATH. */
  readonly bin: string;
  /** The variables that point the fake at its report and wire files. */
  readonly env: { readonly [name: string]: string };
  /** Every `agy` the recorder started, in order: `--version`, then `acp` per session. */
  processes(): FakeAgyProcess[];
  /** Every line on the `acp` processes' pipes, as the agent's side saw them, in order. */
  wire(): Array<{ direction: "in" | "out" | "err"; line: string }>;
}

export function fakeAgyOnPath(directory: string): FakeAgy {
  const root = fs.mkdtempSync(path.join(directory, "fake-agy-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const node = NODE_EXECUTABLE === "node" ? "node" : JSON.stringify(NODE_EXECUTABLE);
  fs.writeFileSync(path.join(bin, "agy"), `#!/bin/sh\nexec ${node} ${JSON.stringify(path.join(REPO_ROOT, "test", "drivers", "antigravity", "fake-agy-cli.ts"))} "$@"\n`, { mode: 0o755 });
  const report = path.join(root, "report.ndjson");
  const wire = path.join(root, "wire.ndjson");
  const lines = (file: string): Array<{ [key: string]: unknown }> => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as { [key: string]: unknown }) : []);
  return {
    bin,
    env: { ARI_FAKE_AGY_REPORT: report, ARI_FAKE_AGY_WIRE: wire },
    processes: () => {
      const processes: FakeAgyProcess[] = [];
      for (const entry of lines(report)) {
        if (entry["args"] !== undefined) processes.push(entry as unknown as FakeAgyProcess);
        else Object.assign(processes.at(-1)!, entry);
      }
      return processes;
    },
    wire: () => lines(wire) as Array<{ direction: "in" | "out" | "err"; line: string }>,
  };
}
