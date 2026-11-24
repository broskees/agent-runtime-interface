// `ari/meta/cursor`: label, icon, config schema and form hints; the config
// schema accepts the driver's default config; the module reaches no Node
// built-in and no vendor package (rule C10(c), which `pnpm run check:rules`
// also enforces); the driver declares the SDK versions it is tested against;
// it launches no CLI, so it has no CLI manifest; and the driver's docs and
// changelog exist.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import ts from "typescript";
import { CURSOR_TESTED_VERSIONS, cursorDriver } from "../../../src/drivers/cursor/index.ts";
import { DriverMetadataSchema, IconSchema } from "../../../src/index.ts";
import * as meta from "../../../src/meta/cursor.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("ari/meta/cursor exports a label, an icon, the config schema and form hints for every config field", () => {
  assert.equal(meta.label, "Cursor");
  assert.equal(meta.kind, cursorDriver.kind);
  assert.ok(IconSchema.is(meta.icon), "the icon is a valid Icon");
  assert.ok(DriverMetadataSchema.is(meta.metadata));
  assert.deepEqual(meta.metadata, cursorDriver.metadata);
  assert.equal(meta.configSchema, cursorDriver.configSchema);
  assert.equal(meta.sdkPackage, "@cursor/sdk");
  const properties = Object.keys((meta.configSchema as { properties: object }).properties);
  assert.deepEqual(Object.keys(meta.formHints).sort(), [...properties].sort());
  for (const hint of Object.values(meta.formHints)) assert.ok(hint.label !== "");
});

test("the config schema is draft 2020-12 and accepts the default config, and rejects a config without a model", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(meta.configSchema as object);
  assert.equal(validate(cursorDriver.defaultConfig()), true, JSON.stringify(validate.errors));
  assert.equal(validate(meta.defaultConfig()), true);
  assert.equal(validate({ model: "gpt-5.5", settingSources: ["project", "user"] }), true);
  assert.equal(validate({}), false);
  assert.equal(validate({ model: "composer-2.5", settingSources: ["everything"] }), false);
  assert.equal(validate({ model: "composer-2.5", apiKey: "secrets do not belong in config" }), false);
});

test("ari/meta/cursor reaches no Node built-in and no vendor package", () => {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    // Static imports, re-exports and dynamic `import()` calls alike.
    for (const { fileName: specifier } of ts.preProcessFile(fs.readFileSync(file, "utf8"), true, true).importedFiles) {
      assert.ok(specifier.startsWith("."), `${path.relative(ROOT, file)} imports ${specifier}`);
      visit(path.resolve(path.dirname(file), specifier));
    }
  };
  visit(path.join(ROOT, "src/meta/cursor.ts"));
  assert.ok(seen.size >= 3);
});

test("the driver declares the SDK versions it is tested against, matching the pinned devDependency and SOURCES.md", () => {
  assert.equal(meta.testedVersions, CURSOR_TESTED_VERSIONS);
  assert.match(CURSOR_TESTED_VERSIONS, /^>=\d+\.\d+\.\d+ <\d+\.\d+\.\d+$/);
  const sources = fs.readFileSync(path.join(ROOT, "test/drivers/cursor/SOURCES.md"), "utf8");
  const pinned = /@cursor\/sdk@(\d+\.\d+\.\d+)/.exec(sources)?.[1];
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { devDependencies: { [name: string]: string }; peerDependencies: { [name: string]: string }; peerDependenciesMeta: { [name: string]: { optional?: boolean } } };
  assert.equal(packageJson.devDependencies["@cursor/sdk"], pinned, "the pinned devDependency matches SOURCES.md");
  assert.ok(CURSOR_TESTED_VERSIONS.startsWith(`>=${pinned} `), "the tested range starts at the pinned version");
  assert.equal(packageJson.peerDependencies["@cursor/sdk"], `^${pinned}`);
  assert.equal(packageJson.peerDependenciesMeta["@cursor/sdk"]?.optional, true);
});

test("the driver launches no CLI, so it has no CLI manifest", () => {
  assert.equal(cursorDriver.cliManifest, undefined);
});

test("the driver's docs and changelog exist and describe the driver as built", () => {
  const docs = fs.readFileSync(path.join(ROOT, "docs/drivers/cursor.md"), "utf8");
  const changelog = fs.readFileSync(path.join(ROOT, "changelogs/cursor.md"), "utf8");
  assert.ok(docs.includes(CURSOR_TESTED_VERSIONS));
  for (const topic of ["in_process", "JsonlLocalAgentStore", "onDelta", "run.steer", "run.cancel", "agent.summarize", "Agent.resume", "first_user_message", "hostTools.mcpServerFor", "CURSOR_DATA_DIR", "session.replaced"]) {
    assert.ok(docs.includes(topic), `docs/drivers/cursor.md does not mention ${topic}`);
  }
  assert.match(changelog, /^# /m);
  assert.ok(changelog.includes("@cursor/sdk"));
});
