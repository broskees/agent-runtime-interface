// The one list of recording scenarios: exactly six, each with prompts, a
// runtime policy, host actions and checks, and the recorders and replay
// tests take their prompts from it and hold none of their own.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "../helpers/spec.ts";
import { SCENARIOS, SCENARIO_NAMES, scenarioNamed } from "./scenarios.ts";

test("the scenario module defines exactly six scenarios: simple, multi_turn, approval_allowed, approval_denied, interrupt and resume", () => {
  assert.deepEqual(
    SCENARIOS.map((scenario) => scenario.name),
    ["simple", "multi_turn", "approval_allowed", "approval_denied", "interrupt", "resume"],
  );
  assert.deepEqual([...SCENARIO_NAMES], ["simple", "multi_turn", "approval_allowed", "approval_denied", "interrupt", "resume"]);
  assert.throws(() => scenarioNamed("steer"), /no scenario is named "steer"; the scenarios are simple, multi_turn, approval_allowed, approval_denied, interrupt, resume/);
});

test("each scenario gives its prompts, runtime policy and host actions", () => {
  for (const scenario of SCENARIOS) {
    assert.ok(scenario.prompts.length > 0 && scenario.prompts.every((prompt) => prompt.trim() !== ""), scenario.name);
    assert.equal(scenario.policy.mode, "approval_required", `${scenario.name} runs under approval_required`);
    assert.equal(scenario.policy.interaction, "default");
    assert.ok(scenario.host.answer === "allow_once" || scenario.host.answer === "decline", scenario.name);
  }
  assert.equal(scenarioNamed("approval_allowed").host.answer, "allow_once");
  assert.equal(scenarioNamed("approval_denied").host.answer, "decline");
  assert.equal(scenarioNamed("interrupt").host.interruptAfterFirstText, true);
  assert.equal(scenarioNamed("resume").host.resumeBeforeTurn, 1);
  assert.deepEqual(
    SCENARIOS.filter((scenario) => scenario.host.interruptAfterFirstText || scenario.host.resumeBeforeTurn !== undefined).map((scenario) => scenario.name),
    ["interrupt", "resume"],
  );
});

test("the word scenarios give the word in the first prompt and ask for it in the second", () => {
  for (const name of ["multi_turn", "resume"] as const) {
    const scenario = scenarioNamed(name);
    assert.equal(scenario.prompts.length, 2);
    assert.ok(scenario.word !== undefined && scenario.prompts[0]!.includes(scenario.word), name);
    assert.ok(!scenario.prompts[1]!.includes(scenario.word!), `${name}: the second prompt does not give the word away`);
  }
});

test("the approval command prints the marker, and only its output can hold it", () => {
  for (const name of ["approval_allowed", "approval_denied"] as const) {
    const scenario = scenarioNamed(name);
    assert.ok(scenario.marker !== undefined && scenario.command !== undefined, name);
    assert.ok(scenario.prompts[0]!.includes(scenario.command!), `${name}: the prompt asks for the command`);
    assert.ok(!scenario.prompts[0]!.includes(scenario.marker!), `${name}: the prompt does not hold the marker`);
    assert.ok(!scenario.command!.includes(scenario.marker!), `${name}: the command text does not hold the marker`);
    // printf '<prefix>-%s\n' '<rest>' prints the marker.
    const match = /^printf '([^']*)%s\\n' '([^']*)'/.exec(scenario.command!);
    assert.ok(match !== null, scenario.command);
    assert.equal(`${match[1]}${match[2]}`, scenario.marker);
  }
  assert.notEqual(scenarioNamed("approval_allowed").marker, scenarioNamed("approval_denied").marker);
});

test("the recorders and replay code import the scenario module and hold no scenario prompts of their own", () => {
  const files = [
    "scripts/record-claude.ts",
    ...fs.readdirSync(path.join(REPO_ROOT, "test", "recordings", "claude")).map((name) => `test/recordings/claude/${name}`),
    "test/drivers/claude/puppets.ts",
    "test/drivers/claude/replay.test.ts",
    "test/drivers/claude/recorder.test.ts",
    "scripts/record-codex.ts",
    ...fs.readdirSync(path.join(REPO_ROOT, "test", "recordings", "codex")).map((name) => `test/recordings/codex/${name}`),
    "test/drivers/codex/puppets.ts",
    "test/drivers/codex/fake-codex-cli.ts",
    "test/drivers/codex/recordings.test.ts",
    "test/drivers/codex/recorder.test.ts",
  ];
  for (const file of files) {
    const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
    for (const scenario of SCENARIOS) {
      for (const prompt of scenario.prompts) {
        // The first sentence of every prompt is long and particular enough to show a copy.
        const sentence = prompt.split(/[.:]/)[0]!;
        assert.ok(sentence.length >= 20);
        assert.ok(!text.includes(sentence), `${file} holds a prompt of ${scenario.name}: ${JSON.stringify(sentence)}`);
      }
    }
  }
  for (const file of ["scripts/record-claude.ts", "test/recordings/claude/record.ts", "test/recordings/claude/replay.ts", "test/drivers/claude/puppets.ts", "test/recordings/codex/record.ts", "test/recordings/codex/replay.ts", "test/drivers/codex/puppets.ts"]) {
    assert.match(fs.readFileSync(path.join(REPO_ROOT, file), "utf8"), /recordings\/scenarios\.ts"|\.\.\/scenarios\.ts"/, `${file} imports the scenario module`);
  }
});
