// File-backed secrets: one file per `(namespace, key)` at
// `<stateDir>/secrets/<namespace>/<key>`, using the safe names of
// safe-name.ts, with `stateDir` kept as given (see os-path.ts). Files are mode
// 0600 and their directories mode 0700.
//
// A write goes to a temporary file in the same directory, is flushed, and is
// then renamed over the target. Rename is atomic, so a reader sees the old
// value or the new one, and two processes writing the same key at once leave
// one complete value. Temporary names start with `.`, which no safe name does,
// so they never collide with a key.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { callErrors } from "../errors.ts";
import type { HostServices } from "../runtime.ts";
import { appendToPath } from "./os-path.ts";
import { encodePathSegment } from "./safe-name.ts";

export type FileSecrets = HostServices["secrets"];

/** Refuses a namespace or key that contains `..` or `/`, as the secret key schema requires. */
function checkSecretName(field: "namespace" | "key", name: string): void {
  if (typeof name !== "string" || name === "" || name.includes("..") || name.includes("/")) {
    throw callErrors.validation(
      [{ path: [field], message: "must be a non-empty string without `..` or `/`" }],
      `Invalid secret ${field}: it must be a non-empty string without ".." or "/"`,
    );
  }
}

async function createPrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Secrets stored as private files under `stateDir`. */
export function createFileSecrets(options: { stateDir: string }): FileSecrets {
  const secretsRoot = appendToPath(options.stateDir, ["secrets"]);

  const locate = (namespace: string, key: string): { directory: string; file: string } => {
    checkSecretName("namespace", namespace);
    checkSecretName("key", key);
    const directory = appendToPath(secretsRoot, [encodePathSegment(namespace, "namespace")]);
    return { directory, file: appendToPath(directory, [encodePathSegment(key, "key")]) };
  };

  return {
    async get(namespace, key) {
      const { file } = locate(namespace, key);
      try {
        // A copy, so the caller holds exactly the secret's bytes and nothing else from Node's buffers.
        return new Uint8Array(await fs.readFile(file));
      } catch (error) {
        if (isMissingFile(error)) return null;
        throw error;
      }
    },

    async set(namespace, key, value) {
      const { directory, file } = locate(namespace, key);
      if (!(value instanceof Uint8Array)) {
        throw callErrors.validation([{ path: ["value"], message: "must be bytes (a Uint8Array)" }], "Invalid secret value: it must be bytes");
      }
      await createPrivateDirectory(secretsRoot);
      await createPrivateDirectory(directory);
      const temporaryFile = appendToPath(directory, [`.tmp-${process.pid}-${randomUUID()}`]);
      try {
        const handle = await fs.open(temporaryFile, "wx", 0o600);
        try {
          await handle.chmod(0o600);
          await handle.writeFile(value);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temporaryFile, file);
      } catch (error) {
        await fs.rm(temporaryFile, { force: true });
        throw error;
      }
    },

    async delete(namespace, key) {
      const { file } = locate(namespace, key);
      await fs.rm(file, { force: true });
    },
  };
}
