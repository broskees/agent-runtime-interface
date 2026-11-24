// `ari/meta/pi`: label, icon, config schema and form hints; the config schema
// accepts the driver's default config; the driver declares the Pi versions it
// is tested against; its CLI manifest is valid and builds the three launches;
// and the driver's docs and changelog exist.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { buildCliLaunch, validateCliManifest } from "../../../src/cli-manifests/index.ts";
import { PI_TESTED_VERSIONS, piDriver } from "../../../src/drivers/pi/index.ts";
import { DriverMetadataSchema, IconSchema } from "../../../src/index.ts";
import * as meta from "../../../src/meta/pi.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("ari/meta/pi exports a label, an icon, the config schema and form hints for every config field", () => {
  assert.equal(meta.label, "Pi");
  assert.equal(meta.kind, piDriver.kind);
  assert.ok(IconSchema.is(meta.icon), "the icon is a valid Icon");
  assert.ok(DriverMetadataSchema.is(meta.metadata));
  assert.deepEqual(meta.metadata, piDriver.metadata);
  assert.equal(meta.configSchema, piDriver.configSchema);
  const properties = Object.keys((meta.configSchema as { properties: object }).properties);
  assert.deepEqual(Object.keys(meta.formHints).sort(), [...properties].sort());
  for (const hint of Object.values(meta.formHints)) assert.ok(hint.label !== "");
});

test("the config schema is draft 2020-12 and accepts the default config, and rejects a config without a binary", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(meta.configSchema as object);
  assert.equal(validate(piDriver.defaultConfig()), true, JSON.stringify(validate.errors));
  assert.equal(validate(meta.defaultConfig()), true);
  assert.equal(validate({ binary: "/opt/pi/bin/pi", provider: "anthropic", model: "anthropic/claude-sonnet-4-5", thinking: "high" }), true);
  assert.equal(validate({}), false);
  assert.equal(validate({ binary: "pi", thinking: "extreme" }), false);
  assert.equal(validate({ binary: "pi", apiKey: "secrets do not belong in config" }), false);
});

test("the driver declares the Pi versions it is tested against", () => {
  assert.equal(meta.testedVersions, PI_TESTED_VERSIONS);
  assert.match(PI_TESTED_VERSIONS, /^>=\d+\.\d+\.\d+ <\d+\.\d+\.\d+$/);
  const sources = fs.readFileSync(path.join(ROOT, "test/drivers/pi/SOURCES.md"), "utf8");
  const pinned = /@earendil-works\/pi-coding-agent@(\d+\.\d+\.\d+)/.exec(sources)?.[1];
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { devDependencies: { [name: string]: string } };
  assert.equal(packageJson.devDependencies["@earendil-works/pi-coding-agent"], pinned, "the pinned devDependency matches SOURCES.md");
  assert.ok(PI_TESTED_VERSIONS.startsWith(`>=${pinned} `), "the tested range starts at the pinned version");
});

test("the CLI manifest is valid and builds fresh, resume and fork launches of pi", () => {
  const manifest = validateCliManifest(piDriver.cliManifest);
  assert.equal(manifest.binary, "pi");
  const env = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "inherited", OPENAI_API_KEY: "inherited", PI_CODING_AGENT_DIR: "/home/u/.pi/agent" };
  const fresh = buildCliLaunch(manifest, { kind: "fresh", cwd: "/work", env });
  assert.deepEqual(fresh.args, []);
  assert.deepEqual(fresh.env, { PATH: "/usr/bin", PI_CODING_AGENT_DIR: "/home/u/.pi/agent" }, "credential variables are scrubbed");
  assert.deepEqual(buildCliLaunch(manifest, { kind: "resume", cwd: "/work", env, sessionId: "/s/a.jsonl" }).args, ["--session", "/s/a.jsonl"]);
  assert.deepEqual(buildCliLaunch(manifest, { kind: "fork", cwd: "/other", env, sessionId: "/s/a.jsonl" }).args, ["--fork", "/s/a.jsonl"]);
});

test("the driver's docs and changelog exist and describe the driver as built", () => {
  const docs = fs.readFileSync(path.join(ROOT, "docs/drivers/pi.md"), "utf8");
  const changelog = fs.readFileSync(path.join(ROOT, "changelogs/pi.md"), "utf8");
  assert.ok(docs.includes(PI_TESTED_VERSIONS));
  for (const topic of ["--mode rpc", "ari-pi-bridge", "/ari-rewind", "/ari-mcp", "/ari-context", "--fork", "process_per_thread"]) assert.ok(docs.includes(topic), `docs/drivers/pi.md does not mention ${topic}`);
  assert.match(changelog, /^# /m);
  assert.ok(changelog.includes("pi-coding-agent"));
});
