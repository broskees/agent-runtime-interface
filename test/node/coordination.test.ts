// Coordination leases in `ari/node`: `acquire(key, ttlMs)` is exclusive until
// `release` or until the TTL passes.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isAriError, LeaseSchema } from "../../src/index.ts";
import { createCoordination } from "../../src/node/index.ts";

describe("ari/node coordination", () => {
  test("a held key cannot be acquired again until it is released", async () => {
    const coordination = createCoordination();
    const lease = await coordination.acquire("reset-credit:account-1", 60_000);
    assert.ok(lease !== null);
    assert.equal(LeaseSchema.is(lease), true);
    assert.equal(lease.key, "reset-credit:account-1");
    assert.equal(await coordination.acquire("reset-credit:account-1", 60_000), null);
    const other = await coordination.acquire("reset-credit:account-2", 60_000);
    assert.ok(other !== null, "another key is independent");

    await coordination.release(lease.leaseId);
    const next = await coordination.acquire("reset-credit:account-1", 60_000);
    assert.ok(next !== null);
    assert.notEqual(next.leaseId, lease.leaseId);
  });

  test("a lease lapses when its TTL passes, and its stale ID cannot release the next holder", async () => {
    let now = Date.parse("2026-11-23T10:00:00.000Z");
    const coordination = createCoordination({ now: () => now });
    const first = await coordination.acquire("session-lock", 1000);
    assert.ok(first !== null);
    assert.equal(first.expiresAt, "2026-11-23T10:00:01.000Z");

    now += 999;
    assert.equal(await coordination.acquire("session-lock", 1000), null, "still held 1 ms before expiry");
    now += 1;
    const second = await coordination.acquire("session-lock", 1000);
    assert.ok(second !== null, "free once the TTL has passed");

    await coordination.release(first.leaseId);
    assert.equal(await coordination.acquire("session-lock", 1000), null, "the old lease ID released nothing");
    await coordination.release(second.leaseId);
    assert.ok((await coordination.acquire("session-lock", 1000)) !== null);
  });

  test("the TTL is measured on the real clock by default", async () => {
    const coordination = createCoordination();
    assert.ok((await coordination.acquire("short", 40)) !== null);
    assert.equal(await coordination.acquire("short", 40), null);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok((await coordination.acquire("short", 40)) !== null);
  });

  test("releasing an unknown or repeated lease ID does nothing; bad input is refused", async () => {
    const coordination = createCoordination();
    await coordination.release("no-such-lease");
    const lease = await coordination.acquire("k", 1000);
    assert.ok(lease !== null);
    await coordination.release(lease.leaseId);
    await coordination.release(lease.leaseId);
    for (const ttl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(coordination.acquire("k", ttl), (error: unknown) => isAriError(error, "validation"), `ttl ${ttl}`);
    }
    await assert.rejects(coordination.acquire("", 1000), (error: unknown) => isAriError(error, "validation"));
  });
});
