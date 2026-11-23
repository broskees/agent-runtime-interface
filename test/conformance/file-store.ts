// The reference agent's session store in real files, for the agent running as
// a child process: `<dir>/<sessionId>.json`, `<dir>/<sessionId>.lock` and
// `<dir>/counters.json`.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ReferenceStore, StoredSession } from "../../src/conformance/index.ts";

export class FileReferenceStore implements ReferenceStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  nextId(prefix: string): string {
    fs.mkdirSync(this.directory, { recursive: true });
    const file = path.join(this.directory, "counters.json");
    const counters = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as { [prefix: string]: number }) : {};
    const next = (counters[prefix] ?? 0) + 1;
    counters[prefix] = next;
    fs.writeFileSync(file, JSON.stringify(counters));
    return `${prefix}-${next}`;
  }

  load(sessionId: string): StoredSession | undefined {
    const file = path.join(this.directory, `${sessionId}.json`);
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as StoredSession) : undefined;
  }

  save(session: StoredSession): void {
    fs.mkdirSync(this.directory, { recursive: true });
    fs.writeFileSync(path.join(this.directory, `${session.sessionId}.json`), JSON.stringify(session));
  }

  has(sessionId: string): boolean {
    return fs.existsSync(path.join(this.directory, `${sessionId}.json`));
  }

  isLocked(sessionId: string): boolean {
    return fs.existsSync(path.join(this.directory, `${sessionId}.lock`));
  }

  lock(sessionId: string): void {
    fs.writeFileSync(path.join(this.directory, `${sessionId}.lock`), String(process.pid));
  }
}
