// Every OpenCode driver suite, in one test process and in order. As separate
// files they ran alongside every other test file at once, and the extra load
// made a timing-sensitive conformance kit test (a probe step with a 1.5 s
// budget) time out; one file keeps the OpenCode fakes' servers to one process.

import "./opencode/meta.suite.ts";
import "./opencode/sdk-types.suite.ts";
import "./opencode/fidelity.suite.ts";
import "./opencode/availability.suite.ts";
import "./opencode/capabilities.suite.ts";
import "./opencode/instructions.suite.ts";
import "./opencode/quirks.suite.ts";
import "./opencode/conformance.suite.ts";
