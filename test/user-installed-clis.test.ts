// Every CLI driver runs the vendor CLI the user installed and never downloads,
// installs or updates one. Its minimum is the lower bound of its tested range,
// and a CLI below it is refused with `driver_unavailable` naming the vendor's
// update step. This test keeps the documents in step with the code: README.md,
// each CLI driver's docs/drivers/<driver>.md and its changelog state the rule,
// the minimum and the error (the docs' example is the error the code builds),
// each docs page cites the vendor's page for the update step, and
// docs/drivers/antigravity.md no longer describes a managed install.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import { CliTooOldError } from "../src/driver-kit/cli-too-old.ts";
import { OPENCODE_UPDATE_STEP, OPENCODE_V1_MINIMUM_VERSION, OPENCODE_V1_TESTED_VERSIONS, OPENCODE_V2_MINIMUM_VERSION, OPENCODE_V2_TESTED_VERSIONS } from "../src/drivers/opencode/index.ts";
import { PI_MINIMUM_VERSION, PI_TESTED_VERSIONS, PI_UPDATE_STEP } from "../src/drivers/pi/index.ts";
import { ANTIGRAVITY_UPDATE_STEP, meta as antigravityMeta } from "../src/meta/antigravity.ts";
import { CODEX_MINIMUM_VERSION, CODEX_TESTED_VERSIONS, CODEX_UPDATE_STEP } from "../src/meta/codex.ts";
import { FX_UPDATE_STEP, meta as fxMeta } from "../src/meta/fx.ts";
import { GROK_UPDATE_STEP, meta as grokMeta } from "../src/meta/grok.ts";
import { KIRO_UPDATE_STEP, meta as kiroMeta } from "../src/meta/kiro.ts";
import { MUSE_CLI_UPDATE_STEP, MUSE_MINIMUM_VERSION, MUSE_TESTED_VERSIONS } from "../src/meta/muse.ts";
import { REPO_ROOT } from "./helpers/spec.ts";

interface CliDriver {
  readonly kind: string;
  readonly cli: string;
  /** Each minimum with the tested range it is the lower bound of. */
  readonly minimums: ReadonlyArray<{ readonly minimum: string; readonly range: string }>;
  /** The minimum as README.md's table states it. */
  readonly readmeMinimum: string;
  readonly updateStep: string;
  /** The update command as README.md and the changelog name it. */
  readonly updateCommand: string;
  /** The vendor's page the update step comes from. */
  readonly vendorDocs: string;
  /** The example error in the driver's docs page. */
  readonly example: { readonly name: string; readonly version: string; readonly path: string; readonly minimum: string };
}

const CLI_DRIVERS: readonly CliDriver[] = [
  {
    kind: "antigravity",
    cli: "agy",
    minimums: [{ minimum: "1.5.0", range: antigravityMeta.testedVersions.range }],
    readmeMinimum: "1.5.0",
    updateStep: ANTIGRAVITY_UPDATE_STEP,
    updateCommand: "`agy update`",
    vendorDocs: "https://antigravity.google/docs/cli/commands/changelog/",
    example: { name: "Google Antigravity", version: "1.4.9", path: "/usr/local/bin/agy", minimum: "1.5.0" },
  },
  {
    kind: "codex",
    cli: "codex",
    minimums: [{ minimum: CODEX_MINIMUM_VERSION, range: CODEX_TESTED_VERSIONS }],
    readmeMinimum: "0.172.0",
    updateStep: CODEX_UPDATE_STEP,
    updateCommand: "Update using your installation method",
    vendorDocs: "https://learn.chatgpt.com/docs/codex/cli",
    example: { name: "Codex CLI", version: "0.100.0", path: "/usr/local/bin/codex", minimum: CODEX_MINIMUM_VERSION },
  },
  {
    kind: "fx",
    cli: "fx",
    minimums: [{ minimum: "0.0.13", range: fxMeta.testedVersions.range }],
    readmeMinimum: "0.0.13",
    updateStep: FX_UPDATE_STEP,
    updateCommand: "`fx upgrade`",
    vendorDocs: "https://github.com/vercel-labs/fx#install",
    example: { name: "fx", version: "0.0.12", path: "/home/me/.local/bin/fx", minimum: "0.0.13" },
  },
  {
    kind: "grok",
    cli: "grok",
    minimums: [{ minimum: "1.0.70", range: grokMeta.testedVersions.range }],
    readmeMinimum: "1.0.70",
    updateStep: GROK_UPDATE_STEP,
    updateCommand: "`grok update`",
    vendorDocs: "https://docs.x.ai/build/overview#update",
    example: { name: "Grok", version: "1.0.60", path: "/usr/local/bin/grok", minimum: "1.0.70" },
  },
  {
    kind: "kiro",
    cli: "kiro-cli",
    minimums: [{ minimum: "3.0.0", range: kiroMeta.testedVersions.range }],
    readmeMinimum: "3.0.0",
    updateStep: KIRO_UPDATE_STEP,
    updateCommand: "`kiro-cli update`",
    vendorDocs: "https://kiro.dev/docs/reference/cli-commands/#kiro-cli-update",
    example: { name: "Kiro", version: "2.40.1", path: "/usr/local/bin/kiro-cli", minimum: "3.0.0" },
  },
  {
    kind: "muse",
    cli: "muse",
    minimums: [{ minimum: MUSE_MINIMUM_VERSION, range: MUSE_TESTED_VERSIONS }],
    readmeMinimum: "1.4.25",
    updateStep: MUSE_CLI_UPDATE_STEP,
    updateCommand: "curl -fsSL https://dev.meta.ai/install.sh",
    vendorDocs: "https://dev.meta.ai/docs/muse-code/changelog",
    example: { name: "Muse Code", version: "1.4.7", path: "/home/me/.local/bin/muse", minimum: MUSE_MINIMUM_VERSION },
  },
  {
    kind: "opencode",
    cli: "opencode",
    minimums: [
      { minimum: OPENCODE_V1_MINIMUM_VERSION, range: OPENCODE_V1_TESTED_VERSIONS },
      { minimum: OPENCODE_V2_MINIMUM_VERSION, range: OPENCODE_V2_TESTED_VERSIONS },
    ],
    readmeMinimum: "1.19.6 for 1.x, 2.1.2 for 2.x",
    updateStep: OPENCODE_UPDATE_STEP,
    updateCommand: "`opencode upgrade`",
    vendorDocs: "https://opencode.ai/docs/cli/commands/#upgrade",
    example: { name: "OpenCode", version: "2.0.21", path: "/usr/local/bin/opencode", minimum: OPENCODE_V2_MINIMUM_VERSION },
  },
  {
    kind: "pi",
    cli: "pi",
    minimums: [{ minimum: PI_MINIMUM_VERSION, range: PI_TESTED_VERSIONS }],
    readmeMinimum: "1.6.0",
    updateStep: PI_UPDATE_STEP,
    updateCommand: "`pi update`",
    vendorDocs: "https://pi.dev/docs/latest/quickstart",
    example: { name: "Pi", version: "1.5.9", path: "/usr/local/bin/pi", minimum: PI_MINIMUM_VERSION },
  },
];

/** A document's text with every run of whitespace made one space, so a phrase may wrap across lines. */
function read(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), "utf8").replace(/\s+/g, " ");
}

const NEVER_DOWNLOADS = "never downloads, installs or updates";

describe("every CLI driver runs the user's CLI and refuses one that is too old, and its documents say so", () => {
  for (const driver of CLI_DRIVERS) {
    test(`docs/drivers/${driver.kind}.md states the rule, the minimum, the error and the vendor's update step, citing the vendor`, () => {
      const docs = read(`docs/drivers/${driver.kind}.md`);
      assert.ok(docs.includes(NEVER_DOWNLOADS), "it says ARI never downloads the CLI");
      for (const { minimum, range } of driver.minimums) {
        assert.ok(range.startsWith(`>=${minimum} <`), `${driver.kind}: ${minimum} is the lower bound of ${range}`);
        assert.ok(docs.includes(minimum), `it names the minimum ${minimum}`);
      }
      assert.ok(docs.includes("driver_unavailable"));
      const example = new CliTooOldError({ ...driver.example, binary: driver.cli, updateStep: driver.updateStep }).message;
      assert.ok(docs.includes(example), `its example is the error the driver builds: ${example}`);
      assert.ok(docs.includes(driver.vendorDocs), `it cites ${driver.vendorDocs} for the update step`);
    });

    test(`changelogs/${driver.kind}.md states the rule, the minimum and the error`, () => {
      const changelog = read(`changelogs/${driver.kind}.md`);
      assert.ok(changelog.includes(NEVER_DOWNLOADS));
      for (const { minimum } of driver.minimums) assert.ok(changelog.includes(minimum), `it names the minimum ${minimum}`);
      assert.ok(changelog.includes("driver_unavailable"));
      assert.ok(changelog.includes(driver.updateCommand), `it names ${driver.updateCommand}`);
    });
  }

  test("README.md states the rule and, for each CLI driver, the minimum and the update step", () => {
    const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
    assert.ok(readme.replace(/\s+/g, " ").includes(`ARI runs the vendor CLI the user installed and ${NEVER_DOWNLOADS} one.`));
    assert.ok(readme.includes("driver_unavailable"));
    for (const driver of CLI_DRIVERS) {
      const row = readme.split("\n").find((line) => line.startsWith(`| \`${driver.kind}\` | \`${driver.cli}\` |`));
      assert.ok(row !== undefined, `README.md has a row for ${driver.kind}`);
      assert.ok(row.includes(`| ${driver.readmeMinimum} |`), `the row names the minimum: ${row}`);
      assert.ok(row.includes(driver.updateCommand), `the row names ${driver.updateCommand}: ${row}`);
    }
  });

  test("docs/drivers/antigravity.md no longer describes a managed install", () => {
    const docs = fs.readFileSync(path.join(REPO_ROOT, "docs", "drivers", "antigravity.md"), "utf8");
    for (const gone of ["| `installation` |", "| `releaseManifestUrl` |", "| `version` |", "maintenance.install()", "adapters/antigravity-cli", "Managed installs", "installer lease"]) {
      assert.ok(!docs.includes(gone), `it no longer has ${gone}`);
    }
    assert.match(docs, /There is no managed install\./);
  });
});
