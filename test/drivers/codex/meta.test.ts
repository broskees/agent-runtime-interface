// ari/meta/codex: label, icon, config schema with form hints and the tested
// versions, browser-safe; its config schema accepts the driver's default
// config; the driver's CLI manifest is one ari/cli-manifests accepts; and the
// driver's docs and changelog exist and describe it as built.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { buildCliLaunch, validateCliManifest } from "../../../src/cli-manifests/index.ts";
import { CODEX_CLI_MANIFEST, CODEX_TESTED_VERSIONS as DRIVER_TESTED_VERSIONS, codexDriver } from "../../../src/drivers/codex/index.ts";
import { CODEX_CONFIG_SCHEMA, CODEX_FORM_HINTS, CODEX_ICON, CODEX_LABEL, CODEX_METADATA, CODEX_TESTED_VERSIONS, codexDefaultConfig } from "../../../src/meta/codex.ts";
import { ARI_VERSION, isAriError } from "../../../src/index.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { reachableImports } from "./imports.ts";

describe("ari/meta/codex", () => {
  test("exports a label, an icon, metadata, a config JSON Schema with form hints, and the tested Codex versions", () => {
    assert.equal(CODEX_LABEL, "Codex");
    assert.equal(CODEX_ICON.type, "svg");
    assert.match((CODEX_ICON as { svg: string }).svg, /^<svg /);
    assert.deepEqual(CODEX_METADATA, { displayName: "Codex", icon: CODEX_ICON, docsUrl: "https://github.com/openai/codex", multipleInstances: true, hasDefaultInstance: true });
    assert.deepEqual(Object.keys(CODEX_FORM_HINTS).sort(), Object.keys((CODEX_CONFIG_SCHEMA as { properties: object }).properties).sort());
    assert.equal(CODEX_TESTED_VERSIONS, DRIVER_TESTED_VERSIONS);
    assert.equal(codexDriver.kind, "codex");
    assert.equal(codexDriver.ariVersion, ARI_VERSION);
    assert.equal(codexDriver.metadata, CODEX_METADATA);
    assert.equal(codexDriver.configSchema, CODEX_CONFIG_SCHEMA);
  });

  test("the config schema accepts defaultConfig() and refuses a config without a binary", () => {
    const validate = new Ajv2020({ strict: true }).compile(CODEX_CONFIG_SCHEMA as object);
    assert.equal(validate(codexDriver.defaultConfig()), true, JSON.stringify(validate.errors));
    assert.equal(validate(codexDefaultConfig()), true);
    assert.equal(validate({ binaryPath: "/opt/codex/bin/codex", extraArgs: ["-c", "model_reasoning_summary=detailed"], model: "gpt-x", reasoningEffort: "high" }), true);
    assert.equal(validate({}), false);
    assert.equal(validate({ binaryPath: "" }), false);
  });

  test("ari/meta/codex reaches no Node built-in or package (repository rule c)", () => {
    const graph = reachableImports(path.join(REPO_ROOT, "src", "meta", "codex.ts"));
    assert.deepEqual(graph.external, []);
  });

  test("the CLI manifest is valid for ari/cli-manifests and builds fresh, resume and fork launches that keep the environment, credentials included", () => {
    assert.equal(codexDriver.cliManifest, CODEX_CLI_MANIFEST);
    assert.deepEqual(validateCliManifest(CODEX_CLI_MANIFEST), CODEX_CLI_MANIFEST);
    const env = { PATH: "/usr/bin", OPENAI_API_KEY: "sk-inherited", CODEX_API_KEY: "inherited", CODEX_HOME: "/home/me/.codex" };
    assert.deepEqual(buildCliLaunch(CODEX_CLI_MANIFEST, { kind: "fresh", cwd: "/w", env }), { command: "codex", args: [], env, cwd: "/w", files: [] });
    assert.deepEqual(buildCliLaunch(CODEX_CLI_MANIFEST, { kind: "resume", cwd: "/w", sessionId: "019a", env }).args, ["resume", "019a"]);
    assert.deepEqual(buildCliLaunch(CODEX_CLI_MANIFEST, { kind: "fork", cwd: "/w", sessionId: "019a", env }).args, ["fork", "019a"]);
    assert.throws(() => buildCliLaunch(CODEX_CLI_MANIFEST, { kind: "fresh", cwd: "/w", env, mcpServers: [{ name: "x", transport: "stdio", command: "x" }] }), (error) => isAriError(error, "unsupported"));
  });

  test("docs/drivers/codex.md and changelogs/codex.md exist and describe the driver as built", () => {
    const docs = fs.readFileSync(path.join(REPO_ROOT, "docs", "drivers", "codex.md"), "utf8");
    const changelog = fs.readFileSync(path.join(REPO_ROOT, "changelogs", "codex.md"), "utf8");
    for (const fact of [
      "rust-v0.172.0",
      CODEX_TESTED_VERSIONS,
      "codex.goal",
      "codex.review",
      "codex.readState",
      "codex.memory",
      "ari.goal",
      "x:codex.searchTerm",
      "codex.chatgpt_auth_tokens",
      // The documented limit on the host's per-thread tool server for a new or forked thread, which launch-context.test.ts exercises.
      "tests/suite/v2/thread_resume.rs:521–566",
      "core/src/session/session.rs:2169–2180",
      'applyNetworkPolicyAmendment:["allow","registry.npmjs.org"]',
    ]) {
      assert.ok(docs.includes(fact), `docs/drivers/codex.md does not mention ${fact}`);
    }
    assert.match(changelog, /rust-v0\.172\.0/);
  });
});
