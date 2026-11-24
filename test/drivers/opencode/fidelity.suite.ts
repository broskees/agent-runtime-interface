// The fake answers the routine requests the way the pinned servers do, not
// only in a shape their schemas accept:
// - 2.1.2 lists a session's messages newest first, 50 to a page, with a
//   cursor that pages back to an empty page (`server/src/handlers/message.ts`,
//   `core/src/session/store.ts` `messages`); 1.19.6 answers the whole history
//   oldest first when the call has no `limit` (`session/session.ts`).
// - 2.1.2 refuses to fork a session without messages (`empty_session`) or
//   before a message it does not have (`core/src/session.ts` `fork`,
//   `server/src/handlers/session.ts`), and publishes a fork as
//   `session.forked`.
// - A child session takes its rules once, when OpenCode creates it: 2.1.2
//   copies the parent's, 1.19.6 keeps the parent's denies and directory rules.
// - Removing an MCP entry the location does not have is `McpServerNotFoundError`.

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { FakeWorld, V2_DEFAULT_MESSAGES_LIMIT, startExternalServer, v1ChildRules } from "./fake-opencode.ts";
import type { FakeServer, FakeSession, Generation } from "./fake-opencode.ts";

const servers: FakeServer[] = [];
after(async () => {
  for (const server of servers.splice(0)) await server.exit(null, "SIGKILL");
});

async function serve(generation: Generation): Promise<{ world: FakeWorld; server: FakeServer }> {
  const world = new FakeWorld(generation);
  await world.ready();
  const server = await startExternalServer(world, undefined);
  servers.push(server);
  return { world, server };
}

/** A stored session with `count` alternating user and assistant messages, oldest first. */
function seed(world: FakeWorld, directory: string, count: number): FakeSession {
  const now = Date.now();
  const session: FakeSession = { id: world.nextId("ses"), directory, created: now, updated: now, title: "seeded", rules: [], messages: [], compactions: 0, instructions: new Map(), model: { providerID: "fake", id: "fake-small" }, agent: "build" };
  for (let index = 0; index < count; index += 1) {
    const user = index % 2 === 0;
    session.messages.push({ id: world.nextId("msg"), role: user ? "user" : "assistant", created: now + index, ...(user ? {} : { completed: now + index }), text: user ? `prompt ${index}` : "", steer: false, content: user ? [] : [{ id: world.nextId("prt"), kind: "text", text: `reply ${index}`, start: now + index, end: now + index }], ...(user ? {} : { finish: "stop" as const }) });
  }
  world.sessions.set(session.id, session);
  return session;
}

async function getJson(url: string): Promise<{ status: number; body: { [key: string]: unknown } }> {
  const response = await fetch(url);
  return { status: response.status, body: (await response.json()) as { [key: string]: unknown } };
}

async function post(url: string, body: unknown, method = "POST"): Promise<{ status: number; body: { [key: string]: unknown } | undefined }> {
  const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : (JSON.parse(text) as { [key: string]: unknown }) };
}

type Page = { data: Array<{ id: string }>; cursor: { previous?: string; next?: string } };

describe("the fake follows the pinned servers", () => {
  test("2.1.2: the message list is newest first, 50 to a page, and its next cursor pages back to an empty page", async () => {
    const { world, server } = await serve(2);
    const session = seed(world, "/work", 62);
    const ids = session.messages.map((message) => message.id);
    const first = await getJson(`${server.url}/api/session/${session.id}/message`);
    assert.equal(first.status, 200);
    const page1 = first.body as unknown as Page;
    assert.equal(V2_DEFAULT_MESSAGES_LIMIT, 50);
    assert.deepEqual(
      page1.data.map((message) => message.id),
      ids.slice(-50).reverse(),
      "the unqualified call answers the newest 50, newest first",
    );
    assert.ok(page1.cursor.next !== undefined && page1.cursor.previous !== undefined);
    const page2 = (await getJson(`${server.url}/api/session/${session.id}/message?cursor=${page1.cursor.next}`)).body as unknown as Page;
    assert.deepEqual(
      page2.data.map((message) => message.id),
      ids.slice(0, 12).reverse(),
      "the next page holds the older messages, still newest first",
    );
    const page3 = (await getJson(`${server.url}/api/session/${session.id}/message?cursor=${page2.cursor.next!}`)).body as unknown as Page;
    assert.deepEqual(page3, { data: [], cursor: {} }, "past the oldest message the page is empty and has no cursor");
    // `order=asc` reads oldest first; `limit` is at most 200.
    const ascending = (await getJson(`${server.url}/api/session/${session.id}/message?order=asc&limit=200`)).body as unknown as Page;
    assert.deepEqual(
      ascending.data.map((message) => message.id),
      ids,
    );
    const refused = await getJson(`${server.url}/api/session/${session.id}/message?order=asc&cursor=${page1.cursor.next}`);
    assert.deepEqual(refused, { status: 400, body: { _tag: "InvalidCursorError", message: "Cursor cannot be combined with order" } });
    assert.deepEqual(world.violations, []);
  });

  test("1.19.6: the message list without limit is the whole history, oldest first", async () => {
    const { world, server } = await serve(1);
    const session = seed(world, "/work", 62);
    const listed = await fetch(`${server.url}/session/${session.id}/message?directory=%2Fwork`);
    const body = (await listed.json()) as Array<{ info: { id: string } }>;
    assert.deepEqual(
      body.map((entry) => entry.info.id),
      session.messages.map((message) => message.id),
    );
    assert.deepEqual(world.violations, []);
  });

  test("2.1.2: a fork of a session without messages is empty_session, a fork before an unknown message is MessageNotFoundError, a fork is session.forked", async () => {
    const { world, server } = await serve(2);
    const empty = seed(world, "/work", 0);
    const refused = await post(`${server.url}/api/session/${empty.id}/fork`, {});
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body, { _tag: "InvalidRequestError", message: `Cannot fork empty session: ${empty.id}`, kind: "empty_session" });
    const full = seed(world, "/work", 4);
    full.instructions.set("ari", "Host text.");
    const missing = await post(`${server.url}/api/session/${full.id}/fork`, { before: "msg_unknown" });
    assert.equal(missing.status, 404);
    assert.equal(missing.body?.["_tag"], "MessageNotFoundError");
    const forked = await post(`${server.url}/api/session/${full.id}/fork`, {});
    assert.equal(forked.status, 200);
    const info = (forked.body?.["data"] ?? {}) as { id: string; fork?: { sessionID: string; boundary: { type: string; messageID: string } } };
    assert.deepEqual(info.fork, { sessionID: full.id, boundary: { type: "through", messageID: full.messages.at(-1)!.id } });
    assert.equal(world.sessions.get(info.id)!.instructions.get("ari"), "Host text.", "a fork takes the parent's instruction entries");
    assert.ok(world.frames.some((frame) => frame.direction === "event" && frame.operation === "session.forked"));
    assert.ok(!world.frames.some((frame) => frame.direction === "event" && frame.operation === "session.created" && (frame.body as { data?: { sessionID?: string } }).data?.sessionID === info.id));
    assert.deepEqual(world.violations, []);
  });

  test("1.19.6 forks a session without messages", async () => {
    const { world, server } = await serve(1);
    const empty = seed(world, "/work", 0);
    const forked = await post(`${server.url}/session/${empty.id}/fork?directory=%2Fwork`, {});
    assert.equal(forked.status, 200);
    assert.deepEqual(world.violations, []);
  });

  for (const generation of [1, 2] as const) {
    test(`${generation}.x: a child session takes its rules from the parent once, when OpenCode creates it`, async () => {
      const { world, server } = await serve(generation);
      const rules = [
        { action: "*", resource: "*", effect: "allow" as const },
        { action: "external_directory", resource: "*", effect: "ask" as const },
        { action: "other_*", resource: "*", effect: "deny" as const },
      ];
      const created =
        generation === 1
          ? await post(`${server.url}/session?directory=%2Fwork`, { permission: rules.map((rule) => ({ permission: rule.action, pattern: rule.resource, action: rule.effect })) })
          : await post(`${server.url}/api/session`, { location: { directory: "/work" }, permissions: rules });
      const parentId = String(((generation === 1 ? created.body : created.body?.["data"]) as { id: string }).id);
      const prompt = generation === 1 ? await post(`${server.url}/session/${parentId}/prompt_async?directory=%2Fwork`, { parts: [{ type: "text", text: "Delegate." }] }) : await post(`${server.url}/api/session/${parentId}/prompt`, { text: "Delegate." });
      assert.ok(prompt.status === 200 || prompt.status === 204);
      const run = (await world.turns.next()).value!;
      const child = await run.runSubagent("helper");
      const expected = generation === 1 ? v1ChildRules(rules) : rules;
      assert.deepEqual(world.sessions.get(child.childId)!.rules, expected);
      if (generation === 1) assert.deepEqual(expected, [rules[1], rules[2], { action: "task", resource: "*", effect: "deny" }]);
      // A later change to the parent's rules does not reach the child.
      world.sessions.get(parentId)!.rules.push({ action: "later_*", resource: "*", effect: "deny" });
      assert.ok(!world.sessions.get(child.childId)!.rules.some((rule) => rule.action === "later_*"));
      await child.finish();
      await run.complete();
      assert.deepEqual(world.violations, []);
    });

    test(`${generation}.x: removing an MCP entry the directory does not have is McpServerNotFoundError`, async () => {
      const { world, server } = await serve(generation);
      const answer = generation === 1 ? await post(`${server.url}/mcp/nothing/disconnect?directory=%2Fwork`, undefined) : await post(`${server.url}/api/experimental/mcp/nothing?location%5Bdirectory%5D=%2Fwork`, undefined, "DELETE");
      assert.equal(answer.status, 404);
      assert.equal(answer.body?.["_tag"], "McpServerNotFoundError");
      assert.deepEqual(world.violations, []);
    });
  }
});
