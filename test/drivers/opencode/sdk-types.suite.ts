// The driver calls the pinned SDKs through interfaces it writes out itself
// (src/drivers/opencode/sdk.ts), so its own declarations never name a package
// a consumer may not have. The type-level checks below fail to compile when
// the pinned `@opencode-ai/sdk` 1.19.6 or `@opencode/client` 2.1.2 no longer
// satisfy those interfaces. The runtime checks show the fakes' validators
// catch a frame that does not match the pinned schemas, so the conformance
// runs' empty violation lists mean something.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import type { OpenCode } from "@opencode/client";
import type { V1Client, V1Sdk, V2Client, V2Sdk } from "../../../src/drivers/opencode/index.ts";
import { FakeWorld, startExternalServer } from "./fake-opencode.ts";

// The real clients can be used wherever the driver expects its interfaces.
export const v1ClientFits = (client: OpencodeClient): V1Client => client;
export const v2ClientFits = (client: ReturnType<typeof OpenCode.make>): V2Client => client;
export const v1SdkFits = (sdk: typeof import("@opencode-ai/sdk/v2")): V1Sdk => sdk;
export const v2SdkFits = (sdk: typeof import("@opencode/client")): V2Sdk => sdk;

const V1_CALLS = ["global.health", "event.subscribe", "session.create", "session.get", "session.update", "session.messages", "session.promptAsync", "session.abort", "session.fork", "session.revert", "session.summarize", "permission.reply", "question.reply", "question.reject", "mcp.add", "mcp.disconnect", "config.providers"];
const V2_CALLS = ["server.info", "event.subscribe", "session.create", "session.get", "session.update", "session.active", "session.prompt", "session.switchModel", "session.switchAgent", "session.interrupt", "session.fork", "session.compact", "session.revert.stage", "session.revert.commit", "session.inbox.cancel", "session.instructions.entry.put", "session.instructions.entry.remove", "session.form.reply", "session.form.cancel", "message.list", "permission.reply", "mcp.add", "mcp.remove", "model.list"];

function at(target: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((node, key) => (node === null || node === undefined ? undefined : (node as { [key: string]: unknown })[key]), target);
}

test("the pinned SDK clients have every call the driver makes", async () => {
  const v1: typeof import("@opencode-ai/sdk/v2") = await import("@opencode-ai/sdk/v2");
  const v2: typeof import("@opencode/client") = await import("@opencode/client");
  const client1 = v1.createOpencodeClient({ baseUrl: "http://127.0.0.1:1" });
  const client2 = v2.OpenCode.make({ baseUrl: "http://127.0.0.1:1" });
  for (const call of V1_CALLS) assert.equal(typeof at(client1, call), "function", `@opencode-ai/sdk has no ${call}`);
  for (const call of V2_CALLS) assert.equal(typeof at(client2, call), "function", `@opencode/client has no ${call}`);
});

for (const generation of [1, 2] as const) {
  test(`${generation}.x: the fake records a request, response or event that does not match the pinned schemas`, async () => {
    const world = new FakeWorld(generation);
    await world.ready();
    const server = await startExternalServer(world, undefined);
    try {
      // A body field the operation does not have.
      const path = generation === 1 ? "/session?directory=/tmp" : "/api/session";
      const answer = await fetch(`${server.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: 42, surprise: true }) });
      await answer.body?.cancel();
      assert.ok(world.violations.some((violation) => violation.includes("session.create request")), world.violations.join("\n"));
      // An event that is not the protocol's.
      world.checkEvent(generation === 1 ? { id: "evt_1", type: "session.idle", properties: {} } : { id: "evt_1", created: 1, type: "session.execution.succeeded", data: {} });
      assert.ok(world.violations.some((violation) => violation.startsWith("event ")), world.violations.join("\n"));
      // A response that is not the operation's.
      const matched = world.validator.match("GET", generation === 1 ? "/session/ses_1" : "/api/session/ses_1")!;
      assert.notDeepEqual(world.validator.checkResponse(matched, 200, { id: "ses_1" }, true), []);
    } finally {
      await server.exit(0);
    }
  });
}
