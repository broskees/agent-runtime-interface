// A fake `codex` on PATH for the Codex recorder's tests: a directory with a
// `codex` script that runs ./fake-codex-cli.ts, and the files the fake
// reports to. The recorder passes its own environment on to `codex` (less
// HOME, the XDG directories, TMPDIR and every CODEX_ and OPENAI_ variable), so
// the fake's ARI_FAKE_CODEX_* variables reach it from the recorder's
// environment.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Model } from "../../../src/drivers/codex/generated/protocol.ts";
import { NODE_EXECUTABLE } from "../../helpers/runtime.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";

/** What the fake `codex` prints for `--version`, after `codex-cli `. */
export const FAKE_CODEX_CLI_VERSION = "0.172.0-fake";

function model(id: string, displayName: string, description: string, isDefault: boolean): Model {
  return { id, model: id, displayName, description, hidden: false, isDefault, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }, { reasoningEffort: "medium", description: "Balanced" }] };
}

/** The fake's `model/list` when ARI_FAKE_CODEX_MODELS is not set: a large default model first, then two small ones, named as OpenAI names its small models. */
export const FAKE_CODEX_RECORDER_MODELS: readonly Model[] = [
  model("fake-sol", "Fake Sol", "The default fake model.", true),
  model("fake-luna", "Fake Luna", "A fast, affordable fake model.", false),
  model("fake-mini", "Fake Mini", "A smaller fake model.", false),
];

/** What one fake `codex` process saw when it started, and, for `app-server`, what it loaded and the sign-in it found. */
export interface FakeCodexProcess {
  readonly args: string[];
  readonly env: { [name: string]: string };
  readonly cwd: string;
  readonly loaded?: string[];
  readonly signIn?: string | null;
  readonly signInFile?: string;
}

export interface FakeCodex {
  /** The directory to put first on PATH. */
  readonly bin: string;
  /** The variables that point the fake at its report and wire files. */
  readonly env: { readonly [name: string]: string };
  /** Every `codex` the recorder started, in order. */
  processes(): FakeCodexProcess[];
  /** Every line on the `app-server` processes' pipes, as the app-server's side saw them, in order. */
  wire(): Array<{ direction: "in" | "out" | "err"; line: string }>;
}

export function fakeCodexOnPath(directory: string): FakeCodex {
  const root = fs.mkdtempSync(path.join(directory, "fake-codex-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const node = NODE_EXECUTABLE === "node" ? "node" : JSON.stringify(NODE_EXECUTABLE);
  fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh\nexec ${node} ${JSON.stringify(path.join(REPO_ROOT, "test", "drivers", "codex", "fake-codex-cli.ts"))} "$@"\n`, { mode: 0o755 });
  const report = path.join(root, "report.ndjson");
  const wire = path.join(root, "wire.ndjson");
  const lines = (file: string): Array<{ [key: string]: unknown }> => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as { [key: string]: unknown }) : []);
  return {
    bin,
    env: { ARI_FAKE_CODEX_REPORT: report, ARI_FAKE_CODEX_WIRE: wire },
    processes: () => {
      const processes: FakeCodexProcess[] = [];
      const byPid = new Map<number, FakeCodexProcess>();
      for (const entry of lines(report)) {
        const pid = entry["pid"] as number;
        const { pid: _pid, ...rest } = entry;
        if (entry["args"] !== undefined) {
          const started = rest as unknown as FakeCodexProcess;
          processes.push(started);
          byPid.set(pid, started);
        } else Object.assign(byPid.get(pid)!, rest);
      }
      return processes;
    },
    wire: () => lines(wire) as Array<{ direction: "in" | "out" | "err"; line: string }>,
  };
}
