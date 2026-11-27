// Runs a committed recording through the sanitiser again, after the sanitiser
// learned to replace something it missed. A recording is never edited by
// hand: this reads it with the loader (which checks its checksum), sanitises
// every frame with the same sanitiser and protocol words the driver's
// recorder uses, and writes it with the recorder's writer, which computes the
// checksum again. The header stays as the recorder wrote it.
//
// The frames already hold placeholders where the recorder's workspace, HOME
// and the rest were, and the sanitiser leaves a placeholder as it is, so a
// recording the sanitiser has nothing new to replace in comes out
// byte-identical. scripts/resanitise-recordings.ts runs it on files.

import { readRecording, writeRecording } from "./format.ts";
import { ACP_PROTOCOL_WORDS } from "./acp/protocol-words.ts";
import { CLAUDE_PROTOCOL_WORDS } from "./claude/protocol-words.ts";
import { CODEX_PROTOCOL_WORDS } from "./codex/protocol-words.ts";
import { OPENCODE_PROTOCOL_WORDS } from "./opencode/protocol-words.ts";
import type { ProtocolWords } from "./protocol-places.ts";
import { PLACEHOLDERS, createSanitiser } from "./sanitiser.ts";

const PROTOCOL_WORDS: { readonly [driver: string]: ProtocolWords } = {
  claude: CLAUDE_PROTOCOL_WORDS,
  opencode: OPENCODE_PROTOCOL_WORDS,
  antigravity: ACP_PROTOCOL_WORDS,
  codex: CODEX_PROTOCOL_WORDS,
};

export interface ResanitiseOptions {
  /** The environment whose HOME, PATH, user names and secret values the sanitiser replaces; the recorder's own, so process.env when run by hand. */
  readonly env: { readonly [name: string]: string | undefined };
  /** The OS user name; os.userInfo().username when left out. */
  readonly user?: string;
}

/** Sanitises every frame of `file` again and rewrites it, header and all. Returns whether any byte changed. */
export async function resanitiseRecording(file: string, options: ResanitiseOptions): Promise<boolean> {
  const recording = await readRecording(file);
  const protocolWords = PROTOCOL_WORDS[recording.header.driver];
  if (protocolWords === undefined) throw new Error(`${file}: no sanitiser protocol words for driver ${recording.header.driver}`);
  // The recorder's workspace is long gone, and the frames say <WORKSPACE> where it was.
  const sanitise = createSanitiser({ workspace: PLACEHOLDERS.workspace, env: options.env, protocolWords, antigravity: recording.header.driver === "antigravity", recordedModel: recording.header.model, ...(options.user === undefined ? {} : { user: options.user }) });
  const frames = recording.frames.map((entry) => sanitise(entry.frame));
  const { type: _type, format: _format, sha256: before, ...metadata } = recording.header;
  await writeRecording(file, metadata, frames);
  return (await readRecording(file)).header.sha256 !== before;
}
