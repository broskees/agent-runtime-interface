// Runs committed native recordings through the sanitiser again, after a fix
// to the sanitiser (test/recordings/sanitiser.ts). Use it when a recording
// holds something personal the sanitiser missed: fix the sanitiser, then run
// this on the recordings, on the machine and account that recorded them, so
// the sanitiser knows the same HOME, user name and secret values. It never
// edits a frame by hand; it rewrites each file with the recorder's own
// sanitiser and writer, which computes the checksum again.
//
// Usage: node scripts/resanitise-recordings.ts <recording.ndjson> ...

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resanitiseRecording } from "../test/recordings/resanitise.ts";

const SCRIPT = fileURLToPath(import.meta.url);

async function main(files: readonly string[]): Promise<number> {
  if (files.length === 0) {
    process.stderr.write("resanitise-recordings: name the recordings to sanitise again, for example test/drivers/opencode/recordings/*.ndjson\n");
    return 2;
  }
  for (const file of files) {
    const changed = await resanitiseRecording(path.resolve(file), { env: process.env });
    process.stdout.write(`resanitise-recordings: ${file}: ${changed ? "rewritten" : "unchanged"}\n`);
  }
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT) {
  process.exitCode = await main(process.argv.slice(2));
}
