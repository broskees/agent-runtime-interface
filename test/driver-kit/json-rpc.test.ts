// The JSON-RPC 2.0 peer matches responses by id, handles notifications, error
// responses and requests from the other side, and rejects pending calls when
// closed. Two peers are wired back to back through NDJSON text, as over stdio.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isAriError } from "../../src/index.ts";
import { JSON_RPC_ERROR_CODES, JsonRpcError, JsonRpcPeer, NdjsonDecoder, encodeNdjson } from "../../src/driver-kit/index.ts";
import type { JsonRpcMessage, JsonRpcPeerOptions } from "../../src/driver-kit/index.ts";

/** Two peers connected through NDJSON text, with every frame each side wrote. */
function connectedPair(
  left: Omit<JsonRpcPeerOptions, "send"> = {},
  right: Omit<JsonRpcPeerOptions, "send"> = {},
): { left: JsonRpcPeer; right: JsonRpcPeer; leftFrames: JsonRpcMessage[]; rightFrames: JsonRpcMessage[] } {
  const leftFrames: JsonRpcMessage[] = [];
  const rightFrames: JsonRpcMessage[] = [];
  const toRight = new NdjsonDecoder();
  const toLeft = new NdjsonDecoder();
  const pair: { left?: JsonRpcPeer; right?: JsonRpcPeer } = {};
  pair.left = new JsonRpcPeer({
    ...left,
    send(message) {
      leftFrames.push(message);
      for (const record of toRight.push(encodeNdjson(message))) pair.right!.receive(record.ok ? record.value : undefined);
    },
  });
  pair.right = new JsonRpcPeer({
    ...right,
    send(message) {
      rightFrames.push(message);
      for (const record of toLeft.push(encodeNdjson(message))) pair.left!.receive(record.ok ? record.value : undefined);
    },
  });
  return { left: pair.left, right: pair.right, leftFrames, rightFrames };
}

describe("JSON-RPC 2.0 peer", () => {
  test("responses are matched to calls by id, even out of order", async () => {
    const sent: JsonRpcMessage[] = [];
    const peer = new JsonRpcPeer({ send: (message) => void sent.push(message) });
    const first = peer.request("math/double", { value: 2 });
    const second = peer.request("math/double", { value: 5 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, [
      { jsonrpc: "2.0", id: 1, method: "math/double", params: { value: 2 } },
      { jsonrpc: "2.0", id: 2, method: "math/double", params: { value: 5 } },
    ]);
    peer.receive({ jsonrpc: "2.0", id: 2, result: 10 });
    peer.receive({ jsonrpc: "2.0", id: 1, result: 4 });
    assert.deepEqual(await Promise.all([first, second]), [4, 10]);
    assert.equal(peer.pendingCount, 0);
  });

  test("requests from the other side run the handler and return its result", async () => {
    const { left } = connectedPair(
      {},
      {
        onRequest: (method, params) => {
          if (method === "add") return (params as { a: number; b: number }).a + (params as { a: number; b: number }).b;
          throw new JsonRpcError(JSON_RPC_ERROR_CODES.methodNotFound, `No method ${method}`);
        },
      },
    );
    assert.equal(await left.request("add", { a: 2, b: 3 }), 5);
  });

  test("an error response rejects the call with its code, message and data", async () => {
    const { left } = connectedPair(
      {},
      {
        onRequest: () => {
          throw new JsonRpcError(-32001, "Not supported", { code: "unsupported", capability: "threads.fork" });
        },
      },
    );
    await assert.rejects(left.request("thread/fork"), (error: unknown) => {
      assert.ok(error instanceof JsonRpcError);
      assert.equal(error.code, -32001);
      assert.equal(error.message, "Not supported");
      assert.deepEqual(error.data, { code: "unsupported", capability: "threads.fork" });
      return true;
    });
  });

  test("a request with no handler gets Method not found, and a handler that throws gets Internal error", async () => {
    const noHandler = connectedPair();
    await assert.rejects(noHandler.left.request("anything"), (error: unknown) => error instanceof JsonRpcError && error.code === -32601);

    const throwing = connectedPair({}, { onRequest: () => Promise.reject(new Error("boom")) });
    await assert.rejects(throwing.left.request("anything"), (error: unknown) => error instanceof JsonRpcError && error.code === -32603 && error.message === "boom");
  });

  test("notifications reach the other side's handler and get no response", async () => {
    const received: Array<[string, unknown]> = [];
    const { left, rightFrames } = connectedPair({}, { onNotification: (method, params) => received.push([method, params]) });
    await left.notify("ari/event", { seq: 1 });
    await left.notify("ping");
    assert.deepEqual(received, [
      ["ari/event", { seq: 1 }],
      ["ping", undefined],
    ]);
    assert.deepEqual(rightFrames, []);
  });

  test("both sides can call each other at once", async () => {
    const { left, right } = connectedPair({ onRequest: (method) => `left handled ${method}` }, { onRequest: (method) => `right handled ${method}` });
    const [fromRight, fromLeft] = await Promise.all([left.request("a"), right.request("b")]);
    assert.equal(fromRight, "right handled a");
    assert.equal(fromLeft, "left handled b");
  });

  test("close rejects every pending call with the transport error and refuses new calls", async () => {
    const peer = new JsonRpcPeer({ send: () => undefined });
    const calls = [peer.request("slow/one"), peer.request("slow/two")];
    peer.close();
    for (const call of calls) await assert.rejects(call, (error: unknown) => isAriError(error, "transport"));
    await assert.rejects(peer.request("after"), (error: unknown) => isAriError(error, "transport"));
    await assert.rejects(peer.notify("after"), (error: unknown) => isAriError(error, "transport"));
    assert.equal(peer.closed, true);
    assert.equal(peer.pendingCount, 0);

    const custom = new JsonRpcPeer({ send: () => undefined });
    const call = custom.request("slow");
    custom.close(new Error("agent exited with code 1"));
    await assert.rejects(call, /agent exited with code 1/);
  });

  test("nothing is sent once the peer is closed, even for a call or notification made just before", async () => {
    const sentWhileClosed: JsonRpcMessage[] = [];
    const sent: JsonRpcMessage[] = [];
    const holder: { peer?: JsonRpcPeer } = {};
    holder.peer = new JsonRpcPeer({
      send(message) {
        sent.push(message);
        if (holder.peer?.closed === true) sentWhileClosed.push(message);
      },
    });
    const peer = holder.peer;
    const call = peer.request("session/startTurn", { threadId: "thread-1" });
    const notification = peer.notify("ari/event", { seq: 1 }).catch((error: unknown) => error);
    peer.close();
    await assert.rejects(call, (error: unknown) => isAriError(error, "transport"));
    await notification;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sentWhileClosed, []);
    assert.ok(sent.every((message) => !("method" in message) || message.method !== "never"));
  });

  test("an aborted peer signal closes the peer; closing aborts handlers still running and drops their responses", async () => {
    const controller = new AbortController();
    const sent: JsonRpcMessage[] = [];
    let handlerSignal: AbortSignal | undefined;
    const peer = new JsonRpcPeer({
      send: (message) => void sent.push(message),
      signal: controller.signal,
      onRequest: (_method, _params, context) => {
        handlerSignal = context.signal;
        return new Promise((resolve) => setTimeout(() => resolve("late"), 20));
      },
    });
    const call = peer.request("pending");
    peer.receive({ jsonrpc: "2.0", id: "remote-1", method: "work" });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(call, (error: unknown) => isAriError(error, "transport"));
    assert.equal(handlerSignal?.aborted, true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(sent.filter((message) => "id" in message && message.id === "remote-1").length, 0);
  });

  test("a call's own signal rejects it, and a late response is reported as unmatched", async () => {
    const problems: string[] = [];
    const peer = new JsonRpcPeer({ send: () => undefined, onProtocolError: (problem) => problems.push(problem.message) });
    const controller = new AbortController();
    const call = peer.request("slow", undefined, { signal: controller.signal });
    controller.abort(new Error("timed out"));
    await assert.rejects(call, /timed out/);
    peer.receive({ jsonrpc: "2.0", id: 1, result: "late" });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /matches no pending call/);
  });

  test("a failed send fails its call", async () => {
    const peer = new JsonRpcPeer({ send: () => Promise.reject(new Error("EPIPE")) });
    await assert.rejects(peer.request("x"), /EPIPE/);
    assert.equal(peer.pendingCount, 0);
  });

  test("invalid messages and batches are refused as the specification says", async () => {
    const sent: JsonRpcMessage[] = [];
    const problems: unknown[] = [];
    const peer = new JsonRpcPeer({ send: (message) => void sent.push(message), onProtocolError: (problem) => problems.push(problem.payload) });
    peer.receive([{ jsonrpc: "2.0", id: 1, method: "a" }]);
    peer.receive({ jsonrpc: "2.0", id: 7, method: 42 });
    peer.receive({ jsonrpc: "1.0", id: 8, method: "old" });
    peer.receive("garbage");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, [
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: batches are not supported" } },
      { jsonrpc: "2.0", id: 7, error: { code: -32600, message: "Invalid Request" } },
      { jsonrpc: "2.0", id: 8, error: { code: -32600, message: "Invalid Request" } },
    ]);
    assert.equal(problems.length, 3);
  });
});
