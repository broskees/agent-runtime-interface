// `initialize` negotiates three version axes (proposal §17.5): the contract
// (`ariVersion`, the event grammar range and per-method versions) and the
// persistence version, and it carries the host's capabilities, including
// `host.process` delegation, and its envPolicy.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createFakeHost } from "../../src/conformance/index.ts";
import { isAriError } from "../../src/index.ts";
import type { Handshake } from "../../src/index.ts";
import { connectDriver, defaultMethodVersions, negotiateGrammarVersion, negotiateHandshake, serveDriver } from "../../src/wire/index.ts";
import type { ConnectDriverOptions, ServeDriverOptions, WireTransport } from "../../src/wire/index.ts";
import { createRecordingDriver } from "./fixtures/recording-driver.ts";
import { REFERENCE_DRIVER_MODULE, memoryTransportPair, startBuiltAriDriver } from "./helpers.ts";

const BASE: Handshake = { ariVersion: "1.0.0", grammarVersions: [1, 1], methodVersions: defaultMethodVersions(), persistenceVersion: { major: 1, minor: 0 } };

/** A transport that keeps every frame it sends. */
function recordingTransport(transport: WireTransport, sent: unknown[]): WireTransport {
  return { ...transport, write: (frame) => {
    sent.push(JSON.parse(frame));
    return transport.write(frame);
  } };
}

async function connect(serverOptions: ServeDriverOptions, hostOptions: ConnectDriverOptions = {}) {
  const recording = createRecordingDriver({ full: true });
  const [driverSide, hostSide] = memoryTransportPair();
  const sent: unknown[] = [];
  const server = serveDriver(recording.driver, driverSide, serverOptions);
  const closeAll = async (): Promise<void> => {
    hostSide.close();
    await server.closed;
  };
  try {
    const connection = await connectDriver(recordingTransport(hostSide, sent), hostOptions);
    return { recording, server, connection, sent, close: closeAll };
  } catch (error) {
    await closeAll();
    throw error;
  }
}

describe("negotiateHandshake", () => {
  test("overlapping grammar ranges settle on the highest version both contain", () => {
    assert.equal(negotiateGrammarVersion([1, 3], [2, 5]), 3);
    assert.equal(negotiateGrammarVersion([2, 5], [1, 3]), 3);
    assert.equal(negotiateGrammarVersion([2, 2], [1, 4]), 2);
    assert.equal(negotiateGrammarVersion([1, 1], [1, 1]), 1);
    assert.equal(negotiateGrammarVersion([2, 3], [4, 6]), undefined);
    assert.throws(() => negotiateGrammarVersion([3, 1], [1, 1]), (error: unknown) => isAriError(error, "validation"));
  });

  test("disjoint grammar ranges are refused with an error naming both ranges", () => {
    assert.throws(
      () => negotiateHandshake({ ...BASE, grammarVersions: [2, 3] }, { ...BASE, grammarVersions: [1, 1] }),
      (error: unknown) => isAriError(error, "protocol") && error.message.includes("[2, 3]") && error.message.includes("[1, 1]"),
    );
  });

  test("per-method versions: the lower minor of one major, refused across majors, the driver's when the host lists none", () => {
    const negotiated = negotiateHandshake(
      { ...BASE, methodVersions: { "session/startTurn": { major: 1, minor: 0 }, "session/respond": { major: 2, minor: 0 } } },
      { ...BASE, methodVersions: { "session/startTurn": { major: 1, minor: 3 }, "session/respond": { major: 1, minor: 4 }, "session/close": { major: 1, minor: 2 } } },
    );
    assert.deepEqual(negotiated.methodVersions, { "session/startTurn": { major: 1, minor: 0 }, "session/close": { major: 1, minor: 2 } });
    assert.deepEqual(negotiated.refusedMethods, { "session/respond": { host: { major: 2, minor: 0 }, driver: { major: 1, minor: 4 } } });
  });

  test("contract and persistence majors must match; persistence uses the lower minor", () => {
    assert.throws(
      () => negotiateHandshake({ ...BASE, ariVersion: "2.0.0" }, BASE),
      (error: unknown) => isAriError(error, "protocol") && error.message.includes("2.0.0") && error.message.includes("1.0.0"),
    );
    assert.throws(
      () => negotiateHandshake({ ...BASE, persistenceVersion: { major: 2, minor: 1 } }, BASE),
      (error: unknown) => isAriError(error, "protocol") && error.message.includes("2.1") && error.message.includes("1.0"),
    );
    const negotiated = negotiateHandshake({ ...BASE, persistenceVersion: { major: 1, minor: 4 } }, { ...BASE, persistenceVersion: { major: 1, minor: 2 } });
    assert.deepEqual(negotiated.persistenceVersion, { major: 1, minor: 2 });
    assert.deepEqual(negotiated.ariVersions, { host: "1.0.0", driver: "1.0.0" });
  });
});

describe("initialize over ari/wire", () => {
  test("overlapping ranges: both ends use the highest common grammar version", async () => {
    const { connection, server, close } = await connect({ grammarVersions: [1, 3] }, { grammarVersions: [2, 5] });
    try {
      assert.equal(connection.negotiated.grammarVersion, 3);
      assert.equal(server.negotiated?.grammarVersion, 3);
    } finally {
      await close();
    }
  });

  test("disjoint ranges: initialize is refused with an error naming both ranges", async () => {
    await assert.rejects(connect({ grammarVersions: [1, 1] }, { grammarVersions: [2, 3] }), (error: unknown) => {
      assert.ok(isAriError(error, "protocol"), String(error));
      assert.match(error.message, /\[2, 3\]/);
      assert.match(error.message, /\[1, 1\]/);
      return true;
    });
  });

  test("a host with an older minor method version: the method is spoken at the host's minor and still works", async () => {
    const { connection, server, recording, close } = await connect(
      { methodVersions: { "instance/status": { major: 1, minor: 4 } } },
      { methodVersions: { "instance/status": { major: 1, minor: 1 } } },
    );
    try {
      assert.deepEqual(connection.negotiated.methodVersions["instance/status"], { major: 1, minor: 1 });
      assert.deepEqual(server.negotiated?.methodVersions["instance/status"], { major: 1, minor: 1 });
      const instance = await connection.driver.create(createFakeHost(), { instanceId: "older-minor", config: {}, environment: {} });
      assert.deepEqual(await instance.status(), { state: "ready", installed: true });
      assert.equal(recording.calls.filter((call) => call.member === "status").length, 1);
    } finally {
      await close();
    }
  });

  test("a method whose majors differ is refused on both ends, naming both versions; the rest works", async () => {
    const { connection, recording, close } = await connect({ methodVersions: { "instance/status": { major: 2, minor: 0 } } });
    try {
      assert.deepEqual(Object.keys(connection.negotiated.refusedMethods), ["instance/status"]);
      const instance = await connection.driver.create(createFakeHost(), { instanceId: "major", config: {}, environment: {} });
      await assert.rejects(instance.status(), (error: unknown) => isAriError(error, "unsupported") && /1\.0/.test(error.message) && /2\.0/.test(error.message));
      assert.equal(recording.calls.filter((call) => call.member === "status").length, 0, "the call never reached the driver");
      assert.ok((await instance.probe()) !== undefined);
    } finally {
      await close();
    }
  });

  test("initialize sends all three version axes, host.process and the envPolicy", async () => {
    const { sent, server, close } = await connect({}, { delegateProcesses: true, envPolicy: { stripAmbient: ["SECRET_*", "TOKEN"] } });
    try {
      const initialize = sent[0] as { method: string; params: Record<string, unknown> };
      assert.equal(initialize.method, "initialize");
      assert.equal(initialize.params.ariVersion, "1.0.0");
      assert.deepEqual(initialize.params.grammarVersions, [1, 1]);
      assert.deepEqual(initialize.params.persistenceVersion, { major: 1, minor: 0 });
      assert.deepEqual(initialize.params.methodVersions, defaultMethodVersions());
      assert.deepEqual(initialize.params.host, { capabilities: { process: true }, envPolicy: { stripAmbient: ["SECRET_*", "TOKEN"] } });
      assert.equal(server.negotiated?.grammarVersion, 1);
    } finally {
      await close();
    }
  });

  test("the ari-driver bin refuses a host whose grammar range it does not share", async () => {
    await assert.rejects(startBuiltAriDriver({ driver: REFERENCE_DRIVER_MODULE, grammarVersions: [5, 9] }), (error: unknown) => {
      assert.ok(isAriError(error, "protocol"), String(error));
      assert.match(error.message, /\[5, 9\]/);
      assert.match(error.message, /\[1, 1\]/);
      return true;
    });
    const accepted = await startBuiltAriDriver({ driver: REFERENCE_DRIVER_MODULE, grammarVersions: [1, 4] });
    try {
      assert.equal(accepted.negotiated.grammarVersion, 1);
      assert.equal(accepted.driver.kind, "reference");
    } finally {
      await accepted.close();
    }
  });
});
