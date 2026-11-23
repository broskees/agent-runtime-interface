// Cancellation and cleanup without Effect. The driver kit owns structured
// cleanup itself (proposal §17.10), with `AbortSignal` and explicit disposal.
//
// A `CleanupScope` owns the resources of one unit of work (a session, a turn,
// a child process). Register each resource's cleanup with `defer` as it is
// acquired; `close()` aborts the scope's `signal` (so every operation started
// with it stops) and then runs the cleanups in reverse order, one at a time,
// waiting for each. Every cleanup runs even when an earlier one fails; the
// failures are thrown together at the end. Closing again returns the same
// promise. A scope given a parent signal closes when that signal aborts.
//
// Like the standard `DisposableStack`, `defer` on a closed scope throws and
// does not run the cleanup: check `signal.aborted` before acquiring.

export class CleanupScope {
  readonly #controller = new AbortController();
  readonly #cleanups: Array<() => unknown> = [];
  readonly #parent: AbortSignal | undefined;
  readonly #onParentAbort = (): void => {
    void this.close(this.#parent?.reason).catch(() => undefined);
  };
  #closing: Promise<void> | undefined;

  constructor(parent?: AbortSignal) {
    this.#parent = parent;
    if (parent?.aborted === true) this.#onParentAbort();
    else parent?.addEventListener("abort", this.#onParentAbort, { once: true });
  }

  /** Aborts when the scope starts closing. Pass it to every operation the scope owns. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get closed(): boolean {
    return this.#closing !== undefined;
  }

  /** Registers a cleanup to run when the scope closes. Throws when the scope is already closed. */
  defer(cleanup: () => unknown): void {
    if (this.#closing !== undefined) throw new Error("CleanupScope is closed; release the resource yourself");
    this.#cleanups.push(cleanup);
  }

  /**
   * Aborts `signal` with `reason`, then runs every cleanup, last registered
   * first. Rejects with the cleanup's error when one failed, or with an
   * `AggregateError` when several did.
   */
  close(reason?: unknown): Promise<void> {
    if (this.#closing === undefined) {
      this.#parent?.removeEventListener("abort", this.#onParentAbort);
      this.#controller.abort(reason);
      this.#closing = this.#runCleanups();
    }
    return this.#closing;
  }

  async #runCleanups(): Promise<void> {
    const errors: unknown[] = [];
    while (this.#cleanups.length > 0) {
      const cleanup = this.#cleanups.pop()!;
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `${errors.length} cleanups failed`);
  }
}
