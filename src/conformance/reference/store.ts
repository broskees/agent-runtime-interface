// Where the reference agent keeps its sessions: one store per session
// directory, like a CLI agent's session files. Native ids come from counters
// kept in the store, so a fresh store gives the same ids in the same order:
// two rigs that do the same things get the same native ids.
//
// `MemoryReferenceStore` keeps everything in memory. Each write stands for a
// virtual file (`<dir>/<sessionId>.json` or `<dir>/counters.json`) and is
// reported to `onWrite`, so the probe scenario can see an agent that writes
// where it should not. A harness that runs the agent as a child process keeps
// the same data in real files.

import type { StoredSession } from "./protocol.ts";

export interface ReferenceStore {
  /** The next native id with `prefix`, for example `session-1`, then `session-2`. */
  nextId(prefix: string): string;
  load(sessionId: string): StoredSession | undefined;
  save(session: StoredSession): void;
  isLocked(sessionId: string): boolean;
  lock(sessionId: string): void;
}

export class MemoryReferenceStore implements ReferenceStore {
  readonly directory: string;
  readonly #sessions = new Map<string, string>();
  readonly #counters = new Map<string, number>();
  readonly #locked = new Set<string>();
  readonly #onWrite: (path: string) => void;

  /** `onWrite` hears the virtual path of every write. */
  constructor(directory: string, onWrite: (path: string) => void = () => undefined) {
    this.directory = directory;
    this.#onWrite = onWrite;
  }

  nextId(prefix: string): string {
    const next = (this.#counters.get(prefix) ?? 0) + 1;
    this.#counters.set(prefix, next);
    this.#onWrite(`${this.directory}/counters.json`);
    return `${prefix}-${next}`;
  }

  load(sessionId: string): StoredSession | undefined {
    const text = this.#sessions.get(sessionId);
    return text === undefined ? undefined : (JSON.parse(text) as StoredSession);
  }

  save(session: StoredSession): void {
    this.#sessions.set(session.sessionId, JSON.stringify(session));
    this.#onWrite(`${this.directory}/${session.sessionId}.json`);
  }

  isLocked(sessionId: string): boolean {
    return this.#locked.has(sessionId);
  }

  lock(sessionId: string): void {
    this.#locked.add(sessionId);
    this.#onWrite(`${this.directory}/${sessionId}.lock`);
  }

  has(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }
}
