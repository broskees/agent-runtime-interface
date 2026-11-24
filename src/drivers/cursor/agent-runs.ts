// Which Cursor agents the sessions of one instance are starting or running a
// run on, with one lock per agent shared by every session of the instance.
//
// Cursor's store refuses a follow-up run while an agent's last run is not
// terminal, and `send({ local: { force: true } })` expires that run first
// (index.js `getRunForSend`, `expireActiveRunForForceSend`). Forcing must
// never expire a live run. So a run starts under the agent's lock, held from
// the check through the SDK's reservation of the run (`send` resolves after
// it): when a handle of this instance holds a run on the agent, or is
// claiming one, the new run is refused; otherwise it is forced, because any
// run the store still holds as active is one nothing in this instance runs:
// the reservation a closed creating handle left, or a run a crashed process
// left. The agent stays held until its run ended (`run.wait()` settled), when
// Cursor's store has marked it terminal.
//
// Another process, or another instance object, on the same state directory
// is not seen here; the instance's lock file refuses one (instance.ts).

import { callErrors } from "../../errors.ts";

/** A run this instance started on an agent. `release` frees the agent once the run ended. */
export interface HeldRun<T> {
  readonly value: T;
  release(): void;
}

export class AgentRuns {
  readonly #locks = new Map<string, Promise<void>>();
  /** The agents a run of this instance holds, each with the token of the run that holds it. */
  readonly #held = new Map<string, symbol>();

  /**
   * Starts a run on the agent with `start`, under the agent's lock. Rejects
   * with `invalid_state` (`previous_turn_active`) when a run of this instance
   * holds the agent. The agent is held from the check on; a `start` that
   * fails frees it again.
   */
  async start<T>(agentId: string, start: () => Promise<T>): Promise<HeldRun<T>> {
    return this.#locked(agentId, async () => {
      if (this.#held.has(agentId)) throw callErrors.invalidState("previous_turn_active", `A session of this instance is running Cursor agent ${agentId}; its next run waits until that run ends`);
      const token = Symbol(agentId);
      this.#held.set(agentId, token);
      const release = (): void => {
        if (this.#held.get(agentId) === token) this.#held.delete(agentId);
      };
      try {
        return { value: await start(), release };
      } catch (error) {
        release();
        throw error;
      }
    });
  }

  /** Runs `work` once every earlier holder of the agent's lock is done. */
  async #locked<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(agentId) ?? Promise.resolve();
    let unlock!: () => void;
    const mine = new Promise<void>((resolve) => (unlock = resolve));
    const tail = previous.then(() => mine);
    this.#locks.set(agentId, tail);
    await previous;
    try {
      return await work();
    } finally {
      unlock();
      if (this.#locks.get(agentId) === tail) this.#locks.delete(agentId);
    }
  }
}
