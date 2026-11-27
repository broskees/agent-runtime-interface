// Only the first six live Codex captures predate the driver's admission probe.
// Answer that probe beside the tape, not by writing or renumbering tape frames.
import { RecordingFormatError, readRecording } from "../format.ts";
import type { Frame } from "../format.ts";
import type { ScenarioName } from "../scenarios.ts";
import { ReplayDriftError, firstDifference, showFrame } from "../sequencer.ts";
import { startStdioReplay } from "../stdio/replay-process.ts";
import type { StdioReplay, StdioReplayOptions } from "../stdio/replay-process.ts";
import { spawnFrame } from "../stdio/tap.ts";

// Body checksums and login spawn lines from the independently verified captures.
const CAPTURES = {
  simple: { sha256: "b6c763458617c780bce8f451d4a3d9fe0db9361195441791fe7e8dd32e1f1668", loginLines: [2] },
  multi_turn: { sha256: "923c78326de2922a60677f0f13d9e1acd7eb279029d63634678c450238635696", loginLines: [2] },
  approval_allowed: { sha256: "b405b04ee0756e981edf98c6c5141e6f17f096c155c64effab750c3c63fbb4ea", loginLines: [2] },
  approval_denied: { sha256: "0a2c6c3fb56f576606c14d44df80a5964f77e93417f50c50fa0dde92c352a079", loginLines: [2] },
  interrupt: { sha256: "98f80145bc1ff25f6d668207dc87cc792eb527ff28fd7a007d8fa8ec50af0da2", loginLines: [2] },
  resume: { sha256: "5abd9d5a445704807b91b3409b4a95633961208194fe6d27e8de6eedc68f0646", loginLines: [2, 36] },
} satisfies Record<ScenarioName, { sha256: string; loginLines: readonly number[] }>;

const EXPECTED_PROBE: Frame = { dir: "out", kind: "spawn", proc: 0, command: "codex", args: ["--version"], envNames: [], purpose: "probe", stdin: "ignore", timeoutMs: 10_000 };

/** Load from disk so the normal checksum validation runs before the provenance pin is checked. */
export async function readPreAdmissionCodexCapture(file: string) {
  const recording = await readRecording(file);
  const { header } = recording;
  const known = Object.hasOwn(CAPTURES, header.scenario) ? CAPTURES[header.scenario as ScenarioName] : undefined;
  if (known === undefined || known.sha256 !== header.sha256 || header.format !== "1.0" || header.driver !== "codex" || header.source !== "live" ||
      header.vendor !== "codex-cli" || header.vendorVersion !== "0.172.0" || header.sdk !== "codex-app-server" || header.sdkVersion !== "rust-v0.172.0" ||
      header.model !== "gpt-6-luna" || header.recorded !== "2026-11-26") {
    throw new RecordingFormatError(file, 1, "pre-admission replay is only for the six pinned live Codex captures");
  }
  const outbound = recording.frames.filter(({ frame }) => frame.dir === "out");
  const loginLines: readonly number[] = known.loginLines;

  function startReplay(options: StdioReplayOptions): StdioReplay {
    const replay = startStdioReplay(recording, options);
    const supplied = new Set<number>();
    const listeners = new Set<() => void>();
    let failure: ReplayDriftError | undefined;
    const refuse = (line: number, message: string): never => {
      failure ??= new ReplayDriftError(file, line, message);
      for (const listener of listeners) listener();
      throw failure;
    };
    return {
      ...replay,
      process: {
        ...replay.process,
        async spawn(request) {
          const earlierFailure = failure ?? replay.sequencer.failure;
          if (earlierFailure !== undefined) throw earlierFailure;
          // A matched outbound frame advances the original sequencer. At every
          // other position (including a duplicate probe) it owns the spawn.
          const next = outbound[replay.sequencer.matchedOutbound().length];
          if (next === undefined || !loginLines.includes(next.line) || supplied.has(next.line)) {
            return replay.process.spawn(request);
          }
          // Proc 0 is only for comparing this unrecorded request. The replay
          // process service never sees it, so all captured proc IDs stay intact.
          const actual = spawnFrame(0, request);
          if (!replay.sequencer.waitingForDriver()) {
            return refuse(next.line, `replay drift: the compatibility admission probe before recorded line ${next.line} arrived before the previous frames were taken\n  sent: ${showFrame(actual)}`);
          }
          if (firstDifference(EXPECTED_PROBE, actual) !== undefined) {
            return refuse(next.line, `replay drift: expected the compatibility admission probe before recorded line ${next.line}\n  expected probe: ${showFrame(EXPECTED_PROBE)}\n  sent: ${showFrame(actual)}`);
          }
          supplied.add(next.line);
          const unexpected = async (): Promise<never> => refuse(next.line, "replay drift: unexpected write, close, or kill of the compatibility admission probe");
          return {
            stdout: (async function* () { yield new TextEncoder().encode(`codex-cli ${header.vendorVersion}\n`); })(),
            stderr: (async function* () {})(),
            exited: Promise.resolve({ code: 0, signal: null }),
            write: unexpected,
            closeStdin: unexpected,
            kill: unexpected,
          };
        },
      },
      progress: {
        ...replay.progress,
        failure: () => failure ?? replay.progress.failure(),
        onChange(listener) {
          listeners.add(listener);
          const remove = replay.progress.onChange(listener);
          return () => { listeners.delete(listener); remove(); };
        },
      },
    };
  }
  return { recording, startReplay };
}
