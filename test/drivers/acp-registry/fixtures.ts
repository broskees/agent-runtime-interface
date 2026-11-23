// A fixture ACP Registry: an index in the registry's format (the ACP Agent
// Registry RFD and the live index at cdn.agentclientprotocol.com) whose agents
// cover each distribution kind the driver meets, served through a fake
// `fetch`, and a tar.gz archive of one installable agent.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registryTarget } from "../../../src/drivers/acp-registry/index.ts";
import type { RegistryIndex } from "../../../src/drivers/acp-registry/index.ts";
export { fixtureFetch } from "../acp/fixture-fetch.ts";

export const REGISTRY_URL = "https://registry.invalid/registry/v1/latest/registry.json";
export const FAKE_AGENT_ID = "fake-agent";
export const FAKE_AGENT_VERSION = "1.0.0";
export const ARCHIVE_URL = "https://downloads.invalid/fake-agent-1.0.0-linux.tar.gz";
export const TARGET = registryTarget(process.platform, process.arch);

/** The fake agent's archive: `bin/fake-acp-agent`, a script the conformance harness replaces with the SDK-based fake. */
export function agentArchive(): { bytes: Uint8Array; sha256: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ari-registry-archive-"));
  try {
    fs.mkdirSync(path.join(directory, "bin"));
    fs.writeFileSync(path.join(directory, "bin", "fake-acp-agent"), "#!/bin/sh\necho fake-acp-agent 1.0.0\n", { mode: 0o755 });
    const archive = path.join(directory, "agent.tar.gz");
    const result = spawnSync("tar", ["-czf", archive, "-C", directory, "bin"], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`tar failed: ${result.stderr}`);
    const bytes = new Uint8Array(fs.readFileSync(archive));
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** The fixture index. Only `fake-agent` is installable; the others are each refused for a reason the driver must name. */
export function registryIndex(sha256: string): RegistryIndex {
  return {
    version: "1.0.0",
    agents: [
      {
        id: FAKE_AGENT_ID,
        name: "Fake Agent",
        version: FAKE_AGENT_VERSION,
        description: "An ACP agent for tests",
        icon: "https://registry.invalid/fake-agent.svg",
        distribution: { binary: { [TARGET]: { archive: ARCHIVE_URL, cmd: "./bin/fake-acp-agent", args: ["acp"], sha256 } } },
      },
      { id: "npx-agent", name: "Npx Agent", version: "2.0.0", description: "Shipped through npm", distribution: { npx: { package: "@example/npx-agent@2.0.0", args: ["--acp"] } } },
      { id: "uvx-agent", name: "Uvx Agent", version: "2.1.0", description: "Shipped through PyPI", distribution: { uvx: { package: "uvx-agent@2.1.0" } } },
      {
        id: "zip-agent",
        name: "Zip Agent",
        version: "3.0.0",
        description: "Shipped as a zip",
        distribution: { binary: { [TARGET]: { archive: "https://downloads.invalid/zip-agent.zip", cmd: "./zip-agent", sha256: "0".repeat(64) } } },
      },
      {
        id: "unsigned-agent",
        name: "Unsigned Agent",
        version: "4.0.0",
        description: "No digest published",
        distribution: { binary: { [TARGET]: { archive: "https://downloads.invalid/unsigned.tar.gz", cmd: "./unsigned" } } },
      },
    ],
  };
}

/** Lays an installed `fake-agent` out in an instance's cache, as the installer leaves it. */
export function preinstall(cacheDir: string): void {
  const bin = path.join(cacheDir, "adapters", FAKE_AGENT_ID, FAKE_AGENT_VERSION, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "fake-acp-agent"), "#!/bin/sh\n", { mode: 0o755 });
}
