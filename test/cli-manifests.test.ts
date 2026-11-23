// ari/cli-manifests builds argv and env for fresh, resume and fork launches
// from a manifest, scrubs env vars by prefix, injects MCP servers, and
// rejects a manifest missing `binary`.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isAriError } from "../src/index.ts";
import { CliLaunchManifestSchema, buildCliLaunch, mcpServersJson, scrubEnv, validateCliManifest } from "../src/cli-manifests/index.ts";
import type { CliLaunchManifest } from "../src/cli-manifests/index.ts";

const MANIFEST: CliLaunchManifest = {
  binary: "agent",
  envScrubPrefixes: ["ANTHROPIC_", "GOOGLE_APPLICATION_"],
  args: {
    fresh: ["--cwd", "{cwd}"],
    resume: ["--resume", "{sessionId}"],
    fork: ["--resume", "{sessionId}", "--fork-session"],
  },
  mcpInjection: { mode: "inline_json", flag: "--mcp-config" },
};

const ENV = {
  PATH: "/usr/bin",
  HOME: "/home/user",
  ANTHROPIC_API_KEY: "secret",
  ANTHROPIC_BASE_URL: "https://example.invalid",
  GOOGLE_APPLICATION_CREDENTIALS: "/creds.json",
  MY_ANTHROPIC_NOTE: "kept: the prefix must match the start",
  UNSET: undefined,
};

describe("CLI manifests", () => {
  test("a fresh launch fills {cwd} and scrubs the env by prefix", () => {
    const launch = buildCliLaunch(MANIFEST, { kind: "fresh", cwd: "/work", env: ENV });
    assert.deepEqual(launch, {
      command: "agent",
      args: ["--cwd", "/work"],
      env: { PATH: "/usr/bin", HOME: "/home/user", MY_ANTHROPIC_NOTE: "kept: the prefix must match the start" },
      cwd: "/work",
      files: [],
    });
  });

  test("a resume launch fills {sessionId}", () => {
    const launch = buildCliLaunch(MANIFEST, { kind: "resume", cwd: "/work", sessionId: "native-42", env: ENV });
    assert.deepEqual(launch.args, ["--resume", "native-42"]);
    assert.equal(launch.command, "agent");
    assert.equal(launch.env.ANTHROPIC_API_KEY, undefined);
  });

  test("a fork launch fills {sessionId} and keeps its own flags", () => {
    const launch = buildCliLaunch(MANIFEST, { kind: "fork", cwd: "/elsewhere", sessionId: "native-42", env: ENV });
    assert.deepEqual(launch.args, ["--resume", "native-42", "--fork-session"]);
    assert.equal(launch.cwd, "/elsewhere");
  });

  test("explicit env additions are applied after scrubbing", () => {
    const launch = buildCliLaunch(MANIFEST, { kind: "fresh", cwd: "/work", env: ENV, extraEnv: { ANTHROPIC_MODEL: "chosen-by-host" } });
    assert.equal(launch.env.ANTHROPIC_MODEL, "chosen-by-host");
    assert.equal(launch.env.ANTHROPIC_API_KEY, undefined);
    assert.deepEqual(scrubEnv({ A_1: "x", B_1: "y" }, ["A_"]), { B_1: "y" });
  });

  test("a manifest missing binary is rejected with a validation error naming binary", () => {
    const { binary: _binary, ...withoutBinary } = MANIFEST;
    for (const attempt of [() => validateCliManifest(withoutBinary), () => buildCliLaunch(withoutBinary, { kind: "fresh", cwd: "/work", env: {} })]) {
      assert.throws(attempt, (error: unknown) => {
        assert.ok(isAriError(error, "validation"));
        assert.ok(error.callError.code === "validation" && error.callError.issues?.some((issue) => issue.path?.includes("binary")), JSON.stringify(error.callError));
        return true;
      });
    }
    assert.equal(CliLaunchManifestSchema.is(withoutBinary), false);
    assert.equal(CliLaunchManifestSchema.is(MANIFEST), true);
  });

  test("a launch kind the manifest lacks is unsupported, and a resume without a session id is refused", () => {
    const freshOnly: CliLaunchManifest = { binary: "agent", args: { fresh: [] } };
    assert.throws(() => buildCliLaunch(freshOnly, { kind: "fork", cwd: "/work", sessionId: "s", env: {} }), (error: unknown) => isAriError(error, "unsupported"));
    assert.throws(() => buildCliLaunch(MANIFEST, { kind: "resume", cwd: "/work", env: {} }), (error: unknown) => isAriError(error, "validation"));
  });

  test("MCP servers are injected as inline JSON, a config file or an env variable, under the host's names", () => {
    const servers = [
      { name: "host-tools", transport: "stdio", command: "host-mcp", args: ["--thread", "t1"], env: { TOKEN: "abc" } },
      { name: "host-preview", transport: "http", url: "http://127.0.0.1:4100/mcp", headers: { Authorization: "Bearer x" } },
    ];
    const expectedJson = {
      mcpServers: {
        "host-tools": { type: "stdio", command: "host-mcp", args: ["--thread", "t1"], env: { TOKEN: "abc" } },
        "host-preview": { type: "http", url: "http://127.0.0.1:4100/mcp", headers: { Authorization: "Bearer x" } },
      },
    };
    assert.deepEqual(JSON.parse(mcpServersJson(servers)), expectedJson);

    const inline = buildCliLaunch(MANIFEST, { kind: "fresh", cwd: "/work", env: {}, mcpServers: servers });
    assert.equal(inline.args[2], "--mcp-config");
    assert.deepEqual(JSON.parse(inline.args[3]!), expectedJson);

    const fileManifest: CliLaunchManifest = { ...MANIFEST, mcpInjection: { mode: "config_file", flag: "--mcp-config" } };
    const viaFile = buildCliLaunch(fileManifest, { kind: "fresh", cwd: "/work", env: {}, mcpServers: servers, mcpConfigPath: "/tmp/mcp.json" });
    assert.deepEqual(viaFile.args.slice(2), ["--mcp-config", "/tmp/mcp.json"]);
    assert.deepEqual(viaFile.files.map((file) => [file.path, JSON.parse(file.contents)]), [["/tmp/mcp.json", expectedJson]]);
    assert.throws(() => buildCliLaunch(fileManifest, { kind: "fresh", cwd: "/work", env: {}, mcpServers: servers }), (error: unknown) => isAriError(error, "validation"));

    const envManifest: CliLaunchManifest = { ...MANIFEST, mcpInjection: { mode: "env", env: "AGENT_MCP_CONFIG" } };
    const viaEnv = buildCliLaunch(envManifest, { kind: "fresh", cwd: "/work", env: {}, mcpServers: servers });
    assert.deepEqual(JSON.parse(viaEnv.env.AGENT_MCP_CONFIG!), expectedJson);
    assert.deepEqual(viaEnv.args, ["--cwd", "/work"]);

    const { mcpInjection: _injection, ...noInjection } = MANIFEST;
    assert.throws(() => buildCliLaunch(noInjection, { kind: "fresh", cwd: "/work", env: {}, mcpServers: servers }), (error: unknown) => isAriError(error, "unsupported"));
    assert.deepEqual(buildCliLaunch(noInjection, { kind: "fresh", cwd: "/work", env: {} }).args, ["--cwd", "/work"]);
  });
});
