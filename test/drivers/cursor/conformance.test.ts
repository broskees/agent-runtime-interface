// All 15 conformance scenarios against the Cursor driver, with the fake
// @cursor/sdk of fake-sdk.ts on the native side. No test reaches Cursor:
// setup-env.ts refuses every outbound connection, and the last test checks
// that none was tried.

import "./setup-env.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { conformanceTests } from "../../../src/conformance/index.ts";
import { cursorHarness } from "./harness.ts";
import { networkAttempts } from "./setup-env.ts";

const harness = cursorHarness();
after(() => harness.cleanup());

conformanceTests(test, harness);

test("the conformance run made no outbound connection", () => {
  assert.deepEqual(networkAttempts(), []);
});
