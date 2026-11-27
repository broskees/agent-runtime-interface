// The claude driver's managed install unpacks only the bytes it verified: it
// checks each downloaded tarball against the sha512 taken while it was
// verified, just before unpacking (sdk-install.test.ts) and again as the bytes
// stream into the extractor (here). A tarball that changes on disk after that
// last check before unpacking fails its extraction, and nothing is published.
//
// To change the file at exactly that moment, the test patches
// `fs.promises.mkdir` and carries it into the driver's `node:fs/promises`
// imports with `module.syncBuiltinESMExports()`, which Bun 1.3.14 does not
// support; test/bun-excluded.txt leaves this file out of the Bun run.

import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { installClaudeSdk } from "../../../src/drivers/claude/install.ts";
import { CLAUDE_SDK_PACKAGE, CLAUDE_SDK_VERSION } from "../../../src/meta/claude.ts";
import { fixtureSdkEntry, startFixtureRegistry } from "./sdk-fixture.ts";

const temporary: string[] = [];
after(() => {
  for (const directory of temporary) nodeFs.rmSync(directory, { recursive: true, force: true });
});

test("a downloaded tarball that changes on disk while it is unpacked fails the extraction, and nothing is installed", async () => {
  const root = nodeFs.realpathSync(nodeFs.mkdtempSync(path.join(os.tmpdir(), "ari-claude-sdk-node-")));
  temporary.push(root);
  const cacheDir = path.join(root, "cache");
  const tmpDir = path.join(root, "tmp");
  nodeFs.mkdirSync(tmpDir);
  const entry = fixtureSdkEntry(root, CLAUDE_SDK_VERSION);
  // A whole, valid tarball of another SDK package, so only the driver's own check can tell (a flipped byte would already fail gzip's CRC).
  const replacement = fixtureSdkEntry(root, CLAUDE_SDK_VERSION, "a different SDK tarball").tarball;
  const registry = await startFixtureRegistry([entry]);
  const realMkdir = nodeFs.promises.mkdir;
  let changedDuringExtraction = false;
  // The installer creates its staging directory after the driver's last check and before it reads any tarball.
  nodeFs.promises.mkdir = (async (target: nodeFs.PathLike, options?: nodeFs.MakeDirectoryOptions | nodeFs.Mode | null) => {
    if (String(target).includes(`${path.sep}.staging-`) && !changedDuringExtraction) {
      const [download] = nodeFs.readdirSync(tmpDir);
      nodeFs.writeFileSync(path.join(tmpDir, download!, "sdk.tgz"), replacement);
      changedDuringExtraction = true;
    }
    return realMkdir(target, options as nodeFs.MakeDirectoryOptions);
  }) as typeof nodeFs.promises.mkdir;
  syncBuiltinESMExports();
  try {
    await assert.rejects(installClaudeSdk({ cacheDir, tmpDir, registry: registry.url }), (error: { callError?: { code: string; detail?: string; message: string } }) => {
      assert.deepEqual(
        { code: error.callError?.code, detail: error.callError?.detail, message: error.callError?.message },
        { code: "protocol", detail: "integrity_mismatch", message: `The downloaded tarball of ${CLAUDE_SDK_PACKAGE}@${CLAUDE_SDK_VERSION} changed on disk after it was verified` },
      );
      return true;
    });
  } finally {
    nodeFs.promises.mkdir = realMkdir;
    syncBuiltinESMExports();
    await registry.close();
  }
  assert.equal(changedDuringExtraction, true, "the tarball changed after the check before unpacking");
  const sdkDirectory = path.join(cacheDir, "adapters", ...CLAUDE_SDK_PACKAGE.split("/"));
  assert.deepEqual(nodeFs.readdirSync(sdkDirectory).filter((name) => name !== ".locks"), [], "no version, staging or trash directory is left");
  assert.deepEqual(nodeFs.readdirSync(tmpDir), [], "the downloads are gone");
});
