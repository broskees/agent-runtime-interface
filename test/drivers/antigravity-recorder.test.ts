// Runs the Antigravity recorder's suites in this one process, one after
// another: the record-and-replay suite against the fake ACP agent run as
// `agy acp`, then the recorder's own suite (the live-run switch, the user's
// setup, the sign-in and the model). Each records against a fake `agy` that
// starts two processes per session, so they run in sequence here rather than
// as separate files beside the other ACP suites.

import "./antigravity/recordings.suite.ts";
import "./antigravity/recorder.suite.ts";
