// Where the reference agent keeps its sessions: one store per session
// directory, like a CLI agent's session files. Native ids come from counters
// kept in the store, so a fresh store gives the same ids in the same order:
// two rigs that do the same things get the same native ids.
//
// `MemoryReferenceStore` keeps everything in memory and shows its sessions as
// virtual files (`<dir>/<sessionId>.json` and `<dir>/counters.json`), so the
// probe scenario can see an agent that writes where it should not. A harness
// that runs the agent as a child process keeps the same data in real files.

import type { StoredSession } from "./protocol.ts";

export interface ReferenceStore {
  /** The next native id with `prefix`, for example `session-1`, then `session-2`. */
  nextId(prefix: string): string;
  load(sessionId: string): StoredSession | undefined;
  save(session: StoredSession): void;
  isLocked(sessionId: string): boolean;
  lock(sessionId: string): void;
}

/** A virtual file of the memory store. */
export interface VirtualFile {
  readonly path: string;
  readonly size: number;
  /** A counter that grows with every write, standing in for a modification time. */
  readonly modifiedMs: number;
}

export class MemoryReferenceStore implements ReferenceStore {
  readonly directory: string;
  readonly #sessions = new Map<string, string>();
  readonly #counters = new Map<string, number>();
  readonly #locked = new Set<string>();
  readonly #files = new Map<string, VirtualFile>();
  #writes = 0;

  constructor(directory: string) {
    this.directory = directory;
  }

  nextId(prefix: string): string {
    const next = (this.#counters.get(prefix) ?? 0) + 1;
    this.#counters.set(prefix, next);
    this.#write("counters.json", JSON.stringify(Object.fromEntries(this.#counters)));
    return `${prefix}-${next}`;
  }

  load(sessionId: string): StoredSession | undefined {
    const text = this.#sessions.get(sessionId);
    return text === undefined ? undefined : (JSON.parse(text) as StoredSession);
  }

  save(session: StoredSession): void {
    const text = JSON.stringify(session);
    this.#sessions.set(session.sessionId, text);
    this.#write(`${session.sessionId}.json`, text);
  }

  isLocked(sessionId: string): boolean {
    return this.#locked.has(sessionId);
  }

  lock(sessionId: string): void {
    this.#locked.add(sessionId);
  }

  has(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }

  /** The store's virtual files. */
  files(): VirtualFile[] {
    return [...this.#files.values()];
  }

  #write(name: string, text: string): void {
    this.#writes += 1;
    const path = `${this.directory}/${name}`;
    this.#files.set(path, { path, size: text.length, modifiedMs: this.#writes });
  }
}
