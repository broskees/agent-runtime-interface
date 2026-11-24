// The Cursor agents an instance created, kept in its state directory
// (`<stateDir>/cursor-created-agents.json`, agent ids only). `resumeThread`
// resumes only these: the driver puts host launch instructions at the top of
// a resumed thread's next prompt, which Cursor keeps in that agent's
// conversation, so it must never open a conversation the user made with
// Cursor's own SDK, even one in the instance's agent store. The Pi driver
// refuses session files outside its state directory for the same reason.

import { callErrors } from "../../errors.ts";

interface CreatedAgentsFile {
  version: 1;
  agentIds: string[];
}

export class CreatedAgents {
  readonly #file: string;
  #ids: Promise<Set<string>> | undefined;
  #writing: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.#file = `${stateDir}/cursor-created-agents.json`;
  }

  async has(agentId: string): Promise<boolean> {
    return (await this.#load()).has(agentId);
  }

  /** Records an agent the instance just created, on disk before it returns. */
  async add(agentId: string): Promise<void> {
    const ids = await this.#load();
    ids.add(agentId);
    const contents: CreatedAgentsFile = { version: 1, agentIds: [...ids] };
    const text = `${JSON.stringify(contents, null, 2)}\n`;
    // One write at a time, each a whole file put in place by rename, so a crash never leaves half a file.
    const write = this.#writing.then(async () => {
      const fs = await import("node:fs/promises");
      const temporary = `${this.#file}.tmp`;
      await fs.writeFile(temporary, text, { mode: 0o600 });
      await fs.rename(temporary, this.#file);
    });
    this.#writing = write.catch(() => undefined);
    try {
      await write;
    } catch (error) {
      throw callErrors.invalidState("created_agents_unwritable", `The Cursor driver could not record agent ${agentId} in ${this.#file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #load(): Promise<Set<string>> {
    if (this.#ids !== undefined) return this.#ids;
    const loading = this.#read();
    this.#ids = loading;
    // A failed read is tried again next time.
    loading.catch(() => {
      if (this.#ids === loading) this.#ids = undefined;
    });
    return loading;
  }

  async #read(): Promise<Set<string>> {
    const fs = await import("node:fs/promises");
    let parsed: Partial<CreatedAgentsFile>;
    try {
      parsed = JSON.parse(await fs.readFile(this.#file, "utf8")) as Partial<CreatedAgentsFile>;
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return new Set();
      throw callErrors.invalidState("created_agents_unreadable", `The Cursor driver could not read ${this.#file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (parsed.version !== 1 || !Array.isArray(parsed.agentIds) || !parsed.agentIds.every((id) => typeof id === "string")) {
      throw callErrors.invalidState("created_agents_unreadable", `${this.#file} is not a list of the Cursor agents this instance created`);
    }
    return new Set(parsed.agentIds);
  }
}
