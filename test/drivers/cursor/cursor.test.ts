// Every test of the Cursor driver, in one Node process. Each suite loads the
// Cursor SDK; one process instead of nine keeps the start of a full test run
// from loading every file at once, which slows the load-sensitive child
// process checks of the conformance kit's own tests.

import "./setup-env.ts";
import "./sdk-types.suite.ts";
import "./meta.suite.ts";
import "./capabilities.suite.ts";
import "./availability.suite.ts";
import "./auth.suite.ts";
import "./launch-context.suite.ts";
import "./quirks.suite.ts";
import "./real-sdk.suite.ts";
import "./conformance.suite.ts";
