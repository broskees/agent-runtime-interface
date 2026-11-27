// Managed installs for the ACP flavor that installs its agents
// (`acp-registry`). They go through `ari/node`'s adapter installer, which
// unpacks a tarball into `<cacheDir>/adapters/<pkg>/<version>` atomically and
// keeps leased versions; it never runs npx or any other program. This module
// only supplies the tarball: it downloads one archive URL and checks it
// against the sha256 its publisher gave.

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { callErrors } from "../../errors.ts";
import { createAdapterInstaller } from "../../node/installer.ts";
import type { AdapterInstaller, TarballFetch } from "../../node/installer.ts";

export type FetchFunction = typeof globalThis.fetch;

/** An archive the installer can unpack: gzip-compressed or plain tar. */
export function isTarArchive(url: string): boolean {
  return /\.(tar\.gz|tgz|tar)$/.test(url.split(/[?#]/)[0] ?? "");
}

async function* readBody(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Passes `chunks` through and, at the end, fails unless their sha256 is `expected` (hex). */
async function* checked(chunks: AsyncIterable<Uint8Array>, expected: string, label: string): AsyncGenerator<Uint8Array> {
  const hash = createHash("sha256");
  for await (const chunk of chunks) {
    hash.update(chunk);
    yield chunk;
  }
  if (hash.digest("hex") !== expected.toLowerCase()) throw callErrors.protocol("integrity_mismatch", `The archive of ${label} does not match its published sha256 digest`);
}

/** A tarball source for one known archive of one version, checked against its sha256. */
export function archiveFetch(fetchImplementation: FetchFunction, archive: { readonly pkg: string; readonly version: string; readonly url: string; readonly sha256: string }): TarballFetch {
  return async ({ pkg, version, signal }) => {
    const label = `${pkg}@${version}`;
    if (pkg !== archive.pkg || version !== archive.version) throw callErrors.notFound({ resource: "archive", id: label });
    const response = await fetchImplementation(archive.url, signal === undefined ? {} : { signal });
    if (!response.ok || response.body === null) throw callErrors.transport(`The download of ${label} answered ${response.status}`);
    return checked(readBody(response.body), archive.sha256, label);
  };
}

/** An installer for one flavor's agents under the instance's cache directory. Archives unpack as they are (no npm `package/` directory). */
export function flavorInstaller(cacheDir: string, fetchTarball: TarballFetch): AdapterInstaller {
  return createAdapterInstaller({ cacheDir, fetchTarball, strip: 0 });
}

/** The versions installed for `pkg`, read without writing anything. */
export async function installedVersions(cacheDir: string, pkg: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(`${cacheDir}/adapters/${pkg}`, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && /^[0-9A-Za-z]/.test(entry.name)).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** The path of `relative` inside an install directory, refusing one that leaves it. */
export function insideInstall(directory: string, relative: string): string {
  const parts = relative.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === ".." || part.includes("\\"))) throw callErrors.validation([{ path: ["cmd"], message: "leaves the install directory" }], `Refusing command ${relative}`);
  return [directory, ...parts].join("/");
}
