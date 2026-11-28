// ari/meta/muse: label, icon, config schema with form hints and the tested
// versions, browser-safe; its config schema accepts the driver's default
// config; the driver's CLI manifest is one ari/cli-manifests accepts; the
// driver entry reaches only Node built-ins statically and the SDK only
// dynamically; and the driver's docs and changelog exist and describe it as
// built.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { buildCliLaunch, validateCliManifest } from "../../../src/cli-manifests/index.ts";
import { MUSE_CAPABILITIES, MUSE_CLI_MANIFEST, MUSE_TESTED_VERSIONS as DRIVER_TESTED_VERSIONS, museDriver } from "../../../src/drivers/muse/index.ts";
import { MUSE_CONFIG_SCHEMA, MUSE_FORM_HINTS, MUSE_ICON, MUSE_LABEL, MUSE_METADATA, MUSE_SDK_PACKAGE, MUSE_TESTED_VERSIONS, museDefaultConfig } from "../../../src/meta/muse.ts";
import { ARI_VERSION } from "../../../src/index.ts";
import { REPO_ROOT } from "../../helpers/spec.ts";
import { reachableImports } from "./imports.ts";

describe("ari/meta/muse", () => {
  test("exports a label, an icon, metadata, a config JSON Schema with form hints, and the tested Muse versions", () => {
    assert.equal(MUSE_LABEL, "Muse Code");
    assert.equal(MUSE_ICON.type, "svg");
    assert.match((MUSE_ICON as { svg: string }).svg, /^<svg /);
    assert.deepEqual(MUSE_METADATA, { displayName: "Muse Code", icon: MUSE_ICON, docsUrl: "https://meta-models.github.io/muse-code-sdk/", multipleInstances: true, hasDefaultInstance: true });
    assert.deepEqual(Object.keys(MUSE_FORM_HINTS).sort(), Object.keys((MUSE_CONFIG_SCHEMA as { properties: object }).properties).sort());
    assert.equal(MUSE_TESTED_VERSIONS, ">=1.4.25 <1.4.26");
    assert.equal(MUSE_TESTED_VERSIONS, DRIVER_TESTED_VERSIONS);
    assert.equal(MUSE_SDK_PACKAGE, "@muse-code/sdk");
    assert.equal(museDriver.kind, "muse");
    assert.equal(museDriver.ariVersion, ARI_VERSION);
    assert.equal(museDriver.metadata, MUSE_METADATA);
    assert.equal(museDriver.configSchema, MUSE_CONFIG_SCHEMA);
    assert.equal(MUSE_CAPABILITIES.ariVersion, ARI_VERSION);
  });

  test("the config schema accepts defaultConfig() and refuses a config without a binary or with an unknown effort", () => {
    const validate = new Ajv2020({ strict: true }).compile(MUSE_CONFIG_SCHEMA as object);
    assert.equal(validate(museDriver.defaultConfig()), true, JSON.stringify(validate.errors));
    assert.equal(validate(museDefaultConfig()), true);
    assert.equal(validate({ binaryPath: "/opt/muse/bin/muse", extraArgs: ["--verbose"], model: "muse-large-2", providerId: "meta", reasoningEffort: "high" }), true);
    assert.equal(validate({}), false);
    assert.equal(validate({ binaryPath: "" }), false);
    assert.equal(validate({ binaryPath: "muse", reasoningEffort: "turbo" }), false);
  });

  test("ari/meta/muse reaches no Node built-in or package (repository rule c), and the driver reaches the SDK only through its dynamic import", () => {
    assert.deepEqual(reachableImports(path.join(REPO_ROOT, "src", "meta", "muse.ts")).external, []);
    const driver = reachableImports(path.join(REPO_ROOT, "src", "drivers", "muse", "index.ts"));
    assert.deepEqual(
      driver.external.filter((specifier) => !specifier.startsWith("node:")),
      ["@muse-code/sdk"],
    );
    const sdk = fs.readFileSync(path.join(REPO_ROOT, "src", "drivers", "muse", "sdk.ts"), "utf8");
    assert.match(sdk, /await import\(SDK_SPECIFIER\)/);
  });

  test("the CLI manifest is valid for ari/cli-manifests and builds a fresh launch that keeps the environment, credentials included", () => {
    assert.equal(museDriver.cliManifest, MUSE_CLI_MANIFEST);
    assert.deepEqual(validateCliManifest(MUSE_CLI_MANIFEST), MUSE_CLI_MANIFEST);
    const env = { PATH: "/usr/bin", META_API_KEY: "inherited", HOME: "/home/me" };
    assert.deepEqual(buildCliLaunch(MUSE_CLI_MANIFEST, { kind: "fresh", cwd: "/w", env }), { command: "muse", args: [], env, cwd: "/w", files: [] });
  });

  test("the pinned SDK devDependency, the installed SDK, the lockfile and SOURCES.md name the same version and integrity", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { devDependencies: { [name: string]: string }; peerDependencies: { [name: string]: string }; peerDependenciesMeta: { [name: string]: { optional?: boolean } } };
    assert.equal(manifest.devDependencies["@muse-code/sdk"], "1.4.25");
    assert.equal(manifest.peerDependencies["@muse-code/sdk"], "^1.4.25");
    assert.equal(manifest.peerDependenciesMeta["@muse-code/sdk"]?.optional, true);
    const installed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "node_modules", "@muse-code", "sdk", "package.json"), "utf8")) as { version: string };
    assert.equal(installed.version, "1.4.25");
    const lock = fs.readFileSync(path.join(REPO_ROOT, "pnpm-lock.yaml"), "utf8");
    const integrity = /'@muse-code\/sdk@1\.4\.25':\n\s+resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)\}/.exec(lock)?.[1];
    assert.ok(integrity !== undefined, "pnpm-lock.yaml holds no @muse-code/sdk@1.4.25 entry");
    const sources = fs.readFileSync(path.join(REPO_ROOT, "test", "drivers", "muse", "SOURCES.md"), "utf8");
    assert.ok(sources.includes("`@muse-code/sdk` `1.4.25`"), "SOURCES.md does not name the pinned SDK version");
    assert.ok(sources.includes(integrity), "SOURCES.md does not give the lockfile's integrity of the pinned SDK");
    assert.ok(sources.includes("e6ef4a64473d"), "SOURCES.md does not name the SDK repository commit");
  });

  test("docs/drivers/muse.md and changelogs/muse.md exist and describe the driver as built", () => {
    const docs = fs.readFileSync(path.join(REPO_ROOT, "docs", "drivers", "muse.md"), "utf8");
    const changelog = fs.readFileSync(path.join(REPO_ROOT, "changelogs", "muse.md"), "utf8");
    for (const fact of [
      "@muse-code/sdk",
      "1.4.25",
      MUSE_TESTED_VERSIONS,
      "e6ef4a64473d",
      "process_per_thread",
      "first_user_message",
      "developerPrompt",
      "already_terminal",
      "runtime_busy",
      "META_API_KEY",
      "--disable-sandbox",
      "session/start",
      "turn/steer",
      "approval/decide",
      "userInput/answer",
      "threads.fork",
      "threads.rollback",
    ]) {
      assert.ok(docs.includes(fact), `docs/drivers/muse.md does not mention ${fact}`);
    }
    assert.match(changelog, /1\.4\.25/);
  });
});
