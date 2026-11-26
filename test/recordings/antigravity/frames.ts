// The fields Antigravity replay leaves out of the frame comparison.
// docs/recordings.md, "Fields replay ignores", lists them with the same
// reasons; test/recordings/docs.test.ts checks that.

import type { IgnoredField } from "../sequencer.ts";

export const ANTIGRAVITY_IGNORED_FIELDS: readonly IgnoredField[] = [
  {
    driver: "antigravity",
    kind: "stdin",
    field: "message.params.clientInfo.version",
    reason: "the driver's ACP initialize request names the ARI version, which changes with every ARI release",
  },
];
