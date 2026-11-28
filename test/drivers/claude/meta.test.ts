// ari/meta/claude: label, icon, config schema with form hints and the tested
// versions, browser-safe; its config schema accepts the driver's default
// config; the driver's CLI manifest is one ari/cli-manifests accepts; the
// driver's docs and changelog exist and describe it as built; and the pinned
// SDK devDependencies match test/drivers/claude/SOURCES.md.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { buildCliLaunch, validateCliManifest } from "../../../src/cli-manifests/index.ts";
import { CLAUDE_CLI_MANIFEST, CLAUDE_TESTED_VERSIONS as DRIVER_TESTED_VERSIONS, claudeDriver, createClaudeDriver, versionAdvisory } from "../../../src/drivers/claude/index.ts";
import {
  CLAUDE_CONFIG_SCHEMA,
  CLAUDE_DESCRIPTION,
  CLAUDE_FORM_HINTS,
  CLAUDE_ICON,
  CLAUDE_LABEL,
  CLAUDE_METADATA,
  CLAUDE_SDK_PACKAGE,
  CLAUDE_SDK_VERSION,
  CLAUDE_TESTED_CLAUDE_CODE_VERSION,
  CLAUDE_TESTED_VERSIONS,
  claudeDefaultConfig,
} from "../../../src/meta/claude.ts";
import { ARI_VERSION } from "../../../src/version.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { reachableImports } from "./imports.ts";

const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
  devDependencies: { [name: string]: string };
  peerDependencies: { [name: string]: string };
  peerDependenciesMeta: { [name: string]: { optional?: boolean } };
};

describe("ari/meta/claude", () => {
  test("exports a label, an icon, metadata, a config JSON Schema with form hints, and the tested SDK versions the driver declares", () => {
    assert.equal(CLAUDE_LABEL, "Claude");
    assert.match(CLAUDE_DESCRIPTION, /Claude Agent SDK/);
    assert.equal(CLAUDE_ICON.type, "svg");
    assert.match((CLAUDE_ICON as { svg: string }).svg, /^<svg /);
    assert.deepEqual(CLAUDE_METADATA, { displayName: "Claude", icon: CLAUDE_ICON, docsUrl: "https://docs.claude.com/en/docs/agent-sdk/typescript", multipleInstances: true, hasDefaultInstance: true });
    assert.deepEqual(Object.keys(CLAUDE_FORM_HINTS).sort(), Object.keys((CLAUDE_CONFIG_SCHEMA as { properties: object }).properties).sort());
    assert.equal(CLAUDE_TESTED_VERSIONS, DRIVER_TESTED_VERSIONS);
    assert.equal(versionAdvisory("0.3.330"), null);
    assert.equal(versionAdvisory("0.3.331")?.kind, "untested_version");
    assert.equal(claudeDriver.kind, "claude");
    assert.equal(claudeDriver.ariVersion, ARI_VERSION);
    assert.equal(claudeDriver.metadata, CLAUDE_METADATA);
    assert.equal(claudeDriver.configSchema, CLAUDE_CONFIG_SCHEMA);
    assert.equal(createClaudeDriver().kind, "claude");
  });

  test("the config schema accepts defaultConfig() and every field, and refuses bad values", () => {
    const validate = new Ajv2020({ strict: true }).compile(CLAUDE_CONFIG_SCHEMA as object);
    assert.equal(validate(claudeDriver.defaultConfig()), true, JSON.stringify(validate.errors));
    assert.equal(validate(claudeDefaultConfig()), true);
    assert.equal(
      validate({ executablePath: "/opt/claude/bin/claude", model: "opus", effort: "high", settingSources: ["project", "local"] }),
      true,
    );
    assert.equal(validate({ sdkRegistry: "https://registry.npmjs.org" }), false, "sdkRegistry is gone: ARI downloads nothing");
    assert.equal(validate({ sdkDirectory: "/opt/claude-agent-sdk" }), false, "sdkDirectory is gone: the standalone ari-driver has the SDK compiled in");
    assert.equal(validate({ effort: "extreme" }), false);
    assert.equal(validate({ settingSources: ["global"] }), false);
    assert.equal(validate({ executablePath: "" }), false);
    assert.equal(validate({ unknown: true }), false);
  });

  test("ari/meta/claude reaches no Node built-in or package (repository rule c); ari/drivers/claude reaches Node built-ins and, only through import(), the SDK by name", () => {
    assert.deepEqual(reachableImports(path.join(REPO_ROOT, "src", "meta", "claude.ts")).external, []);
    const driver = reachableImports(path.join(REPO_ROOT, "src", "drivers", "claude", "index.ts")).external;
    assert.deepEqual(driver.filter((specifier) => !specifier.startsWith("node:")), [CLAUDE_SDK_PACKAGE]);
  });

  test("the CLI manifest is valid for ari/cli-manifests and builds fresh, resume and fork launches that keep the environment, credentials included", () => {
    assert.equal(claudeDriver.cliManifest, CLAUDE_CLI_MANIFEST);
    assert.deepEqual(validateCliManifest(CLAUDE_CLI_MANIFEST), CLAUDE_CLI_MANIFEST);
    const env = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-inherited", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "o", CLAUDE_CONFIG_DIR: "/home/me/.claude" };
    assert.deepEqual(buildCliLaunch(CLAUDE_CLI_MANIFEST, { kind: "fresh", cwd: "/w", env }), { command: "claude", args: [], env, cwd: "/w", files: [] });
    assert.deepEqual(buildCliLaunch(CLAUDE_CLI_MANIFEST, { kind: "resume", cwd: "/w", sessionId: "5e551011-0000-4000-8000-000000000001", env }).args, ["--resume", "5e551011-0000-4000-8000-000000000001"]);
    assert.deepEqual(buildCliLaunch(CLAUDE_CLI_MANIFEST, { kind: "fork", cwd: "/w", sessionId: "5e551011-0000-4000-8000-000000000001", env }).args, ["--resume", "5e551011-0000-4000-8000-000000000001", "--fork-session"]);
    const withMcp = buildCliLaunch(CLAUDE_CLI_MANIFEST, { kind: "fresh", cwd: "/w", env, mcpServers: [{ name: "host-tools", transport: "stdio", command: "host-tools" }] });
    assert.equal(withMcp.args[0], "--mcp-config");
    assert.deepEqual(JSON.parse(withMcp.args[1]!), { mcpServers: { "host-tools": { type: "stdio", command: "host-tools" } } });
  });

  test("the SDK is an optional peer, and the pinned devDependencies match SOURCES.md and node_modules", () => {
    assert.equal(packageJson.peerDependencies[CLAUDE_SDK_PACKAGE], "^0.3.330");
    assert.equal(packageJson.peerDependenciesMeta[CLAUDE_SDK_PACKAGE]?.optional, true);
    const sources = fs.readFileSync(path.join(REPO_ROOT, "test", "drivers", "claude", "SOURCES.md"), "utf8");
    for (const name of [CLAUDE_SDK_PACKAGE, "@anthropic-ai/sdk", "@modelcontextprotocol/sdk", "zod"]) {
      const pinned = packageJson.devDependencies[name];
      assert.match(pinned ?? "", /^\d+\.\d+\.\d+$/, `${name} is not pinned to one version`);
      const row = sources.split("\n").find((line) => line.startsWith(`| \`${name}\``));
      assert.ok(row?.includes(pinned!), `SOURCES.md does not list ${name} ${pinned}`);
      const installed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "node_modules", ...name.split("/"), "package.json"), "utf8")) as { version: string };
      assert.equal(installed.version, pinned, `node_modules holds ${name} ${installed.version}`);
    }
    assert.equal(packageJson.devDependencies[CLAUDE_SDK_PACKAGE], "0.3.330");
    const sdkManifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), "utf8")) as { claudeCodeVersion: string };
    assert.equal(sdkManifest.claudeCodeVersion, CLAUDE_TESTED_CLAUDE_CODE_VERSION);
  });

  test("docs/drivers/claude.md and changelogs/claude.md exist and describe the driver as built", () => {
    const docs = fs.readFileSync(path.join(REPO_ROOT, "docs", "drivers", "claude.md"), "utf8");
    const changelog = fs.readFileSync(path.join(REPO_ROOT, "changelogs", "claude.md"), "utf8");
    for (const fact of ["0.3.330", "2.1.330", CLAUDE_TESTED_VERSIONS, "claude.hooks", "claude.fileCheckpoints", "ari.goal", "derived: true", "process_per_thread", "forkSession", "resumeSessionAt", "setMcpServers", "alwaysLoad", "stopTask", "steeringInterruptsTools", "canUseTool", "snapshot: false", "claude auth status --json", "allow:localSettings"]) {
      assert.ok(docs.includes(fact), `docs/drivers/claude.md does not mention ${fact}`);
    }
    for (const fact of ["0.3.330", "canUseTool", "forkSession", "claude.hooks", "ari.goal"]) assert.ok(changelog.includes(fact), `changelogs/claude.md does not mention ${fact}`);
    // sdkDirectory is gone: the standalone ari-driver has the SDK compiled in. Only the changelogs name it, as removed.
    for (const file of ["README.md", "docs/drivers/claude.md"]) assert.doesNotMatch(fs.readFileSync(path.join(REPO_ROOT, file), "utf8"), /sdkDirectory/, `${file} names sdkDirectory`);
  });

  test("THIRD-PARTY-NOTICES.md names the SDK the standalone ari-driver compiles in, quotes its licence, and the release attaches it beside the binaries", () => {
    const notice = fs.readFileSync(path.join(REPO_ROOT, "THIRD-PARTY-NOTICES.md"), "utf8");
    assert.ok(notice.includes(`\`${CLAUDE_SDK_PACKAGE}\` ${CLAUDE_SDK_VERSION}`), "the notice names the pinned SDK and its version");
    assert.ok(notice.includes("ARI's own code is under the MIT License"));
    // The SDK's own LICENSE.md, quoted in full: © Anthropic PBC, under Anthropic's legal agreements.
    const licence = fs.readFileSync(path.join(fs.realpathSync(path.join(REPO_ROOT, "node_modules", ...CLAUDE_SDK_PACKAGE.split("/"))), "LICENSE.md"), "utf8");
    const words = (text: string): string => text.replace(/^> /gm, "").replace(/\s+/g, " ").trim();
    assert.ok(licence.includes("© Anthropic PBC") && licence.includes("https://code.claude.com/docs/en/legal-and-compliance"), licence);
    assert.ok(words(notice).includes(words(licence)), `THIRD-PARTY-NOTICES.md does not quote the SDK's LICENSE.md: ${licence}`);
    const release = fs.readFileSync(path.join(REPO_ROOT, ".github", "workflows", "release.yml"), "utf8");
    assert.match(release, /^ {10}cp THIRD-PARTY-NOTICES\.md build\/release\/THIRD-PARTY-NOTICES\.md$/m, "the build job copies the notice beside the binaries");
    assert.match(release, /gh release create [^\n]*\\\n(?: {12}\S+ \\\n)* {12}build\/release\/THIRD-PARTY-NOTICES\.md \\\n/, "gh release create attaches the notice");
    assert.match(fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8"), /\[`THIRD-PARTY-NOTICES\.md`\]\(THIRD-PARTY-NOTICES\.md\)/);
  });
});
