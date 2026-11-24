// Every test suite of the Muse driver, in one test process. Each suite would
// end with its own type check of the frames it recorded (a TypeScript program
// over the Muse SDK's wire types), and ten such compiles running beside the
// rest of the gate slowed real-time checks in other drivers' child-process
// harnesses. In one process the suites run one after another, and the
// `after` hook that test/drivers/muse/frames.ts registers type-checks every
// frame of every suite once, when this file ends. A Muse test file added on
// its own still gets the same check: frames.ts registers the hook in every
// test process that imports the fake.

import "./muse/frames.suite.ts";
import "./muse/sdk-types.suite.ts";
import "./muse/meta.suite.ts";
import "./muse/availability.suite.ts";
import "./muse/protocol.suite.ts";
import "./muse/launch-context.suite.ts";
import "./muse/capabilities.suite.ts";
import "./muse/conformance.suite.ts";
