// Runs the 15 conformance scenarios against the Pi driver and a fake
// `pi --mode rpc` in child processes.

import { after } from "node:test";
import test from "node:test";
import { conformanceTests } from "../../../src/conformance/index.ts";
import { piHarness } from "./harness.ts";

const harness = piHarness();
after(() => harness.cleanup());

conformanceTests(test, harness);
