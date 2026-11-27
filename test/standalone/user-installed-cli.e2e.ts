// The standalone `ari-driver` runs the vendor CLI the user installed and
// never downloads one: over ari/wire, with a PATH that holds no `node` and no
// `bun`, the `codex` and `antigravity` drivers find a fake `codex` or `agy` on
// that PATH (a /bin/sh script that logs its arguments and prints a version).
//   - below the driver's minimum: `instance/status` reports
//     `driver_unavailable` naming the version, the path, the minimum and the
//     vendor's update step; `openSession` rejects the same way; the CLI ran
//     only with `--version`;
//   - at the minimum: ready, with no advisory;
//   - above the tested range: ready, with the untested_version advisory.
// The antigravity instance has no `maintenance` member, and a config that
// names the old `installation` setting is refused.
//
// The gate runs it after the binary build (`pnpm run test:binary`).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isAriError } from "../../src/index.ts";
import { ANTIGRAVITY_CLI_MANIFEST, ANTIGRAVITY_DEFAULT_CONFIG, ANTIGRAVITY_UPDATE_STEP } from "../../src/meta/antigravity.ts";
import { CODEX_MINIMUM_VERSION, CODEX_TESTED_VERSIONS, CODEX_UPDATE_STEP } from "../../src/meta/codex.ts";
import { meta as antigravityMeta } from "../../src/meta/antigravity.ts";
import { createCoordination, createNodeHostServices } from "../../src/node/index.ts";
import { startAriDriver } from "../../src/wire/index.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ARI_DRIVER = path.join(ROOT, "build", "standalone", "linux-x64", "ari-driver");

const temporary: string[] = [];
after(() => {
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
});

/** Single-quotes `text` for /bin/sh. */
function shellQuoted(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

interface FakeCli {
  readonly root: string;
  readonly project: string;
  readonly executable: string;
  readonly env: { [name: string]: string };
  /** The argument lists the fake CLI was run with, oldest first. */
  invocations(): string[];
}

/**
 * A temp root whose `bin/` holds only `name`: a /bin/sh script that appends its arguments to a log and answers
 * `--version` with `versionLine` (and `login status` as a signed-in Codex does), using shell builtins only.
 */
function fakeCli(name: string, versionLine: string): FakeCli {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-user-cli-")));
  temporary.push(root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  for (const directory of [bin, home, project]) fs.mkdirSync(directory);
  const log = path.join(root, "invocations.log");
  const executable = path.join(bin, name);
  fs.writeFileSync(
    executable,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${shellQuoted(log)}`,
      'case "$*" in',
      `  --version) printf '%s\\n' ${shellQuoted(versionLine)} ;;`,
      "  'login status') printf 'Logged in using ChatGPT\\n' >&2 ;;",
      "  *) exit 64 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const env = {
    PATH: bin,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
  };
  for (const runtime of ["node", "nodejs", "bun"]) assert.equal(fs.existsSync(path.join(bin, runtime)), false, "the PATH holds no node or bun");
  return {
    root,
    project,
    executable,
    env,
    invocations: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((line) => line !== "") : []),
  };
}

/** Starts the standalone ari-driver serving `driver`, with host services under `cli.root`, and runs `body` with an instance of `config`. */
async function withInstance(
  driver: "codex" | "antigravity",
  cli: FakeCli,
  config: { readonly [field: string]: unknown },
  body: (instance: Awaited<ReturnType<Awaited<ReturnType<typeof startAriDriver>>["driver"]["create"]>>) => Promise<void>,
  options: { environment?: { readonly [name: string]: string }; delegateProcesses?: boolean } = {},
): Promise<void> {
  assert.ok(fs.existsSync(ARI_DRIVER), `${path.relative(ROOT, ARI_DRIVER)} is missing; run \`pnpm run build:binary\` first`);
  const host = await createNodeHostServices<typeof config>({
    hostRoot: path.join(cli.root, "host"),
    instanceId: `${driver}-user-cli`,
    baseEnv: cli.env,
    config: { get: async () => ({ config }) },
    attachments: { resolve: async () => null },
    hostTools: {
      mcpServerFor: async () => {
        throw new Error("this host serves no tools");
      },
    },
    callbacks: { register: async (flowId) => ({ url: `http://127.0.0.1:9/${flowId}` }) },
    coordination: createCoordination(),
    writeDiagnostic: () => undefined,
  });
  // A host that builds its environment policy from the CLI manifest, as Antigravity's driver requires.
  const stripAmbient = driver === "antigravity" ? (ANTIGRAVITY_CLI_MANIFEST.envScrubPrefixes ?? []).map((prefix) => `${prefix}*`) : [];
  const connection = await startAriDriver({ driver, command: [ARI_DRIVER], env: cli.env, cwd: cli.project, envPolicy: { stripAmbient }, delegateProcesses: options.delegateProcesses ?? false });
  try {
    const instance = await connection.driver.create(host, { instanceId: `${driver}-user-cli`, config, environment: options.environment ?? {} });
    try {
      await body(instance);
    } finally {
      await instance.dispose();
    }
  } finally {
    await connection.close();
    await host.dispose();
  }
}

const CASES = [
  {
    driver: "codex" as const,
    binary: "codex",
    config: { binaryPath: "codex" },
    name: "Codex CLI",
    minimum: CODEX_MINIMUM_VERSION,
    updateStep: CODEX_UPDATE_STEP,
    testedRange: CODEX_TESTED_VERSIONS,
    below: { line: "codex-cli 0.171.0", version: "0.171.0" },
    atMinimum: { line: "codex-cli 0.172.0", version: "0.172.0" },
    above: { line: "codex-cli 0.173.0", version: "0.173.0" },
  },
  {
    driver: "antigravity" as const,
    binary: "agy",
    config: { ...ANTIGRAVITY_DEFAULT_CONFIG },
    name: "Google Antigravity",
    minimum: "1.5.0",
    updateStep: ANTIGRAVITY_UPDATE_STEP,
    testedRange: antigravityMeta.testedVersions.range,
    below: { line: "1.4.9", version: "1.4.9" },
    atMinimum: { line: "1.5.0", version: "1.5.0" },
    above: { line: "1.6.0", version: "1.6.0" },
  },
];

for (const each of CASES) {
  test(`the standalone ari-driver refuses an old ${each.binary} in status and openSession, accepts the minimum and advises on newer versions (${each.driver})`, async () => {
    const cli = fakeCli(each.binary, each.below.line);
    await withInstance(each.driver, cli, each.config, async (instance) => {
      const status = await instance.status();
      assert.equal(status.state, "unavailable", JSON.stringify(status));
      assert.equal(status.installed, true);
      assert.equal(status.version, each.below.version);
      assert.equal(status.advisory, undefined);
      assert.equal(status.error?.code, "driver_unavailable");
      assert.equal(status.error?.message, `${each.name} ${each.below.version} (${cli.executable}) is older than ${each.minimum}, the oldest version this driver supports. ${each.updateStep}`);
      assert.equal((status.error as { installHint?: string }).installHint, each.updateStep);
      await assert.rejects(instance.openSession({}), (error: unknown) => isAriError(error, "driver_unavailable") && error.message === status.error?.message);
      assert.deepEqual(Object.keys(instance.maintenance ?? {}).filter((member) => member !== "advisory"), [], "the instance installs and updates nothing");
    });
    assert.deepEqual(cli.invocations(), ["--version", "--version"], `${each.binary} ran only with --version: no agent started`);
    for (const [found, advised] of [
      [each.atMinimum, false],
      [each.above, true],
    ] as const) {
      const cli = fakeCli(each.binary, found.line);
      await withInstance(each.driver, cli, each.config, async (instance) => {
        const status = await instance.status();
        assert.equal(status.state, "ready", JSON.stringify(status));
        assert.equal(status.version, found.version);
        assert.equal(status.error, undefined);
        if (!advised) assert.equal(status.advisory, undefined);
        else {
          assert.equal(status.advisory?.kind, "untested_version");
          assert.equal(status.advisory?.currentVersion, found.version);
          assert.equal(status.advisory?.testedRange, each.testedRange);
        }
      });
      assert.ok(cli.invocations().includes("--version"), "the fake on PATH ran");
    }
  });
}

test("standalone Codex probes the instance PATH in both local and delegated process modes", async () => {
  for (const delegateProcesses of [false, true]) {
    const host = fakeCli("codex", "codex-cli 0.172.0");
    const old = fakeCli("codex", "codex-cli 0.100.0");
    await withInstance("codex", host, { binaryPath: "codex" }, async (instance) => {
      const status = await instance.status();
      assert.equal(status.state, "unavailable");
      assert.equal(status.installed, true);
      assert.equal(status.version, "0.100.0");
      assert.equal(status.error?.code, "driver_unavailable");
      assert.ok(status.error.message.includes(`(${old.executable})`), status.error.message);
      await assert.rejects(instance.openSession({}), (error: unknown) => isAriError(error, "driver_unavailable") && error.message === status.error?.message);
    }, { environment: { PATH: old.env["PATH"]! }, delegateProcesses });
    assert.deepEqual(old.invocations(), ["--version", "--version"]);
    assert.deepEqual(host.invocations(), []);
  }
});

test("the standalone ari-driver's antigravity instance has no maintenance member, and refuses a config that names the old installation setting", async () => {
  const cli = fakeCli("agy", "1.5.17");
  await withInstance("antigravity", cli, { ...ANTIGRAVITY_DEFAULT_CONFIG }, async (instance) => {
    assert.equal(instance.maintenance, undefined, "no maintenance member, not even maintenance.advisory");
  });
  const old = { ...ANTIGRAVITY_DEFAULT_CONFIG, installation: "managed" };
  await assert.rejects(
    withInstance("antigravity", cli, old, async () => {
      assert.fail("create() should have refused the config");
    }),
    (error: unknown) => isAriError(error, "validation") && /ARI no longer downloads, installs or updates the Antigravity CLI/.test(error.message) && error.message.includes("https://antigravity.google/cli/install.sh"),
  );
  assert.deepEqual(cli.invocations(), [], "agy never ran");
});
