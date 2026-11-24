// Every field replay leaves out of the frame comparison, for every driver
// that has native recordings. docs/recordings.md, "Fields replay ignores",
// lists the same fields with the same reasons; test/recordings/docs.test.ts
// checks that.

import { CLAUDE_IGNORED_FIELDS } from "./claude/frames.ts";
import type { IgnoredField } from "./sequencer.ts";

export const REPLAY_IGNORED_FIELDS: readonly IgnoredField[] = [...CLAUDE_IGNORED_FIELDS];
