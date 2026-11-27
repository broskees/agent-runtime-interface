// A spawned process whose end takes longer: `kill()` without a signal waits
// `delayMs` before it ends the process, as a process does that takes the
// whole kill grace to exit. Records when each such end began, so a test can
// tell whether a driver ends its sessions at once or one after another.

import { setTimeout as delay } from "node:timers/promises";
import type { SpawnedProcess } from "../../src/index.ts";

export interface SlowEnds {
  /** `Date.now()` at the start of each `kill()` without a signal, in order. */
  readonly startedAt: number[];
  wrap(process: SpawnedProcess): SpawnedProcess;
}

export function slowEnds(delayMs: number): SlowEnds {
  const startedAt: number[] = [];
  return {
    startedAt,
    wrap(process) {
      let ending: Promise<void> | undefined;
      return {
        pid: process.pid,
        stdout: process.stdout,
        stderr: process.stderr,
        exited: process.exited,
        write: (data) => process.write(data),
        closeStdin: () => process.closeStdin(),
        kill: (signal) => {
          if (signal !== undefined) return process.kill(signal);
          if (ending === undefined) {
            startedAt.push(Date.now());
            ending = delay(delayMs).then(() => process.kill());
          }
          return ending;
        },
      };
    },
  };
}

/** How many ends began within `windowMs` of the first. */
export function endsBegunTogether(startedAt: readonly number[], windowMs: number): number {
  if (startedAt.length === 0) return 0;
  const first = Math.min(...startedAt);
  return startedAt.filter((time) => time - first <= windowMs).length;
}
