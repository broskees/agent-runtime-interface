// Runs the test suites of the five ACP drivers (`acp`, `grok`, `fx`, `kiro`,
// `antigravity`) in this one process, one after another.
//
// Each suite starts dozens of fake agent processes. As separate test files,
// `node --test` ran them all at once, alongside every other file, and the
// burst of a few hundred child processes starved time-sensitive tests
// elsewhere in the suite (a conformance-kit test with a 1.5 s step budget
// timed out). Run here in sequence, they cost the same CPU without the burst.
//
// Each driver's suites live beside it in test/drivers/<name>/*.suite.ts.

import "./acp/vendor.suite.ts";
import "./acp/protocol.suite.ts";
import "./acp/standalone.suite.ts";
import "./acp/conformance.suite.ts";
import "./acp/rules.suite.ts";
import "./grok/conformance.suite.ts";
import "./grok/rules.suite.ts";
import "./grok/grok.suite.ts";
import "./fx/conformance.suite.ts";
import "./fx/rules.suite.ts";
import "./fx/fx.suite.ts";
import "./kiro/conformance.suite.ts";
import "./kiro/rules.suite.ts";
import "./kiro/kiro.suite.ts";
import "./antigravity/conformance.suite.ts";
import "./antigravity/rules.suite.ts";
import "./antigravity/antigravity.suite.ts";
// Last: it checks the frames every suite above recorded.
import "./acp/frames.suite.ts";
