// Coordination leases for one host process. A lease on a key is exclusive:
// while it is held and not expired, `acquire` on the same key returns null.
// The holder gives it up with `release(leaseId)`, or it lapses after `ttlMs`.
//
// Keys are shared by every instance the host gives this object to, because
// some work must be serialized across instances (for example reset-credit
// redemptions for one account). Create one per host and pass it to each
// instance's host services.

import { randomUUID } from "node:crypto";
import { callErrors } from "../errors.ts";
import type { Lease } from "../generated/host.ts";
import type { HostServices } from "../runtime.ts";

export type Coordination = HostServices["coordination"];

export interface CoordinationOptions {
  /** The clock, in milliseconds since the epoch. Defaults to `Date.now`. */
  now?: () => number;
}

interface HeldLease {
  readonly leaseId: string;
  readonly expiresAtMs: number;
}

export function createCoordination(options: CoordinationOptions = {}): Coordination {
  const now = options.now ?? Date.now;
  const holders = new Map<string, HeldLease>();
  const keyOfLease = new Map<string, string>();

  // Forgets every lapsed lease, so keys nobody acquires again do not pile up.
  const dropExpired = (): void => {
    const currentTime = now();
    for (const [key, holder] of holders) {
      if (holder.expiresAtMs > currentTime) continue;
      holders.delete(key);
      keyOfLease.delete(holder.leaseId);
    }
  };

  return {
    async acquire(key: string, ttlMs: number): Promise<Lease | null> {
      if (typeof key !== "string" || key === "") {
        throw callErrors.validation([{ path: ["key"], message: "must be a non-empty string" }], "Invalid lease key");
      }
      if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw callErrors.validation([{ path: ["ttlMs"], message: "must be a positive number" }], "Invalid lease ttlMs");
      }
      dropExpired();
      if (holders.has(key)) return null;
      const leaseId = randomUUID();
      const expiresAtMs = now() + ttlMs;
      holders.set(key, { leaseId, expiresAtMs });
      keyOfLease.set(leaseId, key);
      return { leaseId, key, expiresAt: new Date(expiresAtMs).toISOString() };
    },

    /** Ends a lease. Releasing an unknown, expired or already released lease does nothing. */
    async release(leaseId: string): Promise<void> {
      const key = keyOfLease.get(leaseId);
      if (key === undefined) return;
      keyOfLease.delete(leaseId);
      if (holders.get(key)?.leaseId === leaseId) holders.delete(key);
    },
  };
}
