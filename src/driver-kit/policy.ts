// The runtime-policy rule every driver shares for a thread that already runs.

import type { RuntimePolicy } from "../generated/config.ts";

/**
 * The policy a running thread takes from a turn, or from a resume of a thread
 * the session holds: one that names no mode sends the harness nothing, so the
 * thread keeps the mode it runs. Only a thread that starts (a new thread, a
 * resume that loads it, a fork) takes the harness's own mode.
 */
export function keepingMode(next: RuntimePolicy, current: RuntimePolicy | undefined): RuntimePolicy {
  return next.mode === undefined && current?.mode !== undefined ? { ...next, mode: current.mode } : next;
}
