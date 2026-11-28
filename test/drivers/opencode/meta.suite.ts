// `ari/meta/opencode`: label, icon, config schema and form hints; the config
// schema accepts the driver's default config; the driver declares the OpenCode
// versions it is tested against, which match the pinned SDKs and vendored
// schemas; its CLI manifest is valid and builds its launches; and the
// driver's docs and changelog exist.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { buildCliLaunch, validateCliManifest } from "../../../src/cli-manifests/index.ts";
import { OPENCODE_TESTED_VERSIONS, OPENCODE_V1_TESTED_VERSIONS, OPENCODE_V2_TESTED_VERSIONS, opencodeDriver } from "../../../src/drivers/opencode/index.ts";
import { DriverMetadataSchema, IconSchema } from "../../../src/index.ts";
import * as meta from "../../../src/meta/opencode.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("ari/meta/opencode exports a label, an icon, the config schema and form hints for every config field", () => {
  assert.equal(meta.label, "OpenCode");
  assert.equal(meta.kind, opencodeDriver.kind);
  assert.ok(IconSchema.is(meta.icon), "the icon is a valid Icon");
  assert.ok(DriverMetadataSchema.is(meta.metadata));
  assert.deepEqual(meta.metadata, opencodeDriver.metadata);
  assert.equal(meta.configSchema, opencodeDriver.configSchema);
  const properties = Object.keys((meta.configSchema as { properties: object }).properties);
  assert.deepEqual(Object.keys(meta.formHints).sort(), [...properties].sort());
  for (const hint of Object.values(meta.formHints)) assert.ok(hint.label !== "");
  assert.deepEqual(meta.sdkPackages, { "1.x": "@opencode-ai/sdk", "2.x": "@opencode/client" });
});

test("the config schema is draft 2020-12, accepts the default config, and rejects bad values and secrets", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(meta.configSchema as object);
  assert.equal(validate(opencodeDriver.defaultConfig()), true, JSON.stringify(validate.errors));
  assert.equal(validate(meta.defaultConfig()), true);
  assert.equal(validate({ binary: "/opt/opencode/bin/opencode", serverUrl: "http://127.0.0.1:4096", model: "anthropic/claude-sonnet-4-5", agent: "build" }), true);
  assert.equal(validate({}), false);
  assert.equal(validate({ binary: "opencode", serverUrl: "ftp://host" }), false);
  assert.equal(validate({ binary: "opencode", model: "no-provider" }), false);
  assert.equal(validate({ binary: "opencode", serverPassword: "secrets do not belong in config" }), false);
});

test("the driver declares the OpenCode versions it is tested against, which match the pinned SDKs and the vendored schemas", () => {
  assert.equal(meta.testedVersions, OPENCODE_TESTED_VERSIONS);
  assert.deepEqual(meta.testedVersionsByGeneration, { "1.x": OPENCODE_V1_TESTED_VERSIONS, "2.x": OPENCODE_V2_TESTED_VERSIONS });
  const sources = fs.readFileSync(path.join(ROOT, "test/drivers/opencode/SOURCES.md"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { devDependencies: { [name: string]: string }; peerDependencies: { [name: string]: string }; peerDependenciesMeta: { [name: string]: { optional?: boolean } } };
  for (const [name, range] of [
    ["@opencode-ai/sdk", OPENCODE_V1_TESTED_VERSIONS],
    ["@opencode/client", OPENCODE_V2_TESTED_VERSIONS],
    ["@opencode/protocol", OPENCODE_V2_TESTED_VERSIONS],
  ] as const) {
    const pinned = new RegExp(`${name.replace("/", "\\/")}@(\\d+\\.\\d+\\.\\d+)`).exec(sources)?.[1];
    assert.ok(pinned !== undefined, `SOURCES.md pins ${name}`);
    assert.equal(packageJson.devDependencies[name], pinned, `the pinned devDependency ${name} matches SOURCES.md`);
    assert.ok(range.startsWith(`>=${pinned} `), `the tested range ${range} starts at the pinned ${name}`);
    assert.ok(fs.existsSync(path.join(ROOT, "vendor-schemas/opencode", pinned, "openapi.json")), `the OpenAPI document of ${pinned} is vendored`);
  }
  for (const name of ["@opencode-ai/sdk", "@opencode/client"]) {
    assert.ok(packageJson.peerDependencies[name] !== undefined, `${name} is a peer`);
    assert.equal(packageJson.peerDependenciesMeta[name]?.optional, true, `${name} is optional`);
  }
});

test("each vendored OpenAPI document is the file its SOURCES.md names, by sha256", () => {
  for (const version of ["1.19.6", "2.1.2"]) {
    const directory = path.join(ROOT, "vendor-schemas/opencode", version);
    const recorded = /sha256 `([0-9a-f]{64})`/.exec(fs.readFileSync(path.join(directory, "SOURCES.md"), "utf8"))?.[1];
    const actual = createHash("sha256").update(fs.readFileSync(path.join(directory, "openapi.json"))).digest("hex");
    assert.equal(actual, recorded, `vendor-schemas/opencode/${version}/openapi.json changed without SOURCES.md`);
  }
});

test("the CLI manifest is valid and builds fresh and resume launches of opencode", () => {
  const manifest = validateCliManifest(opencodeDriver.cliManifest);
  assert.equal(manifest.binary, "opencode");
  const env = { PATH: "/usr/bin", OPENCODE_SERVER_PASSWORD: "inherited", OPENCODE_PASSWORD: "inherited", ANTHROPIC_API_KEY: "the user's own" };
  const fresh = buildCliLaunch(manifest, { kind: "fresh", cwd: "/work", env });
  assert.deepEqual(fresh.args, []);
  assert.deepEqual(fresh.env, env, "the launch keeps the environment, server passwords and credentials included");
  assert.deepEqual(buildCliLaunch(manifest, { kind: "resume", cwd: "/work", env, sessionId: "ses_123" }).args, ["--session", "ses_123"]);
});

test("the driver's docs and changelog exist and describe the driver as built", () => {
  const docs = fs.readFileSync(path.join(ROOT, "docs/drivers/opencode.md"), "utf8");
  const changelog = fs.readFileSync(path.join(ROOT, "changelogs/opencode.md"), "utf8");
  assert.ok(docs.includes(OPENCODE_V1_TESTED_VERSIONS));
  assert.ok(docs.includes(OPENCODE_V2_TESTED_VERSIONS));
  for (const topic of ["opencode serve", "process_per_thread", "process_per_instance", "external", "opencode.permissionRules", "@opencode-ai/sdk", "@opencode/client", "/openapi.json", "scope: \"project\"", "deny"]) {
    assert.ok(docs.includes(topic), `docs/drivers/opencode.md does not mention ${topic}`);
  }
  assert.match(changelog, /^# /m);
  assert.ok(changelog.includes("@opencode/client"));
});
