# Changelog: acp driver

## Unreleased

- Added the ACP base driver (`ari/drivers/acp`, `ari/meta/acp`): runs any
  Agent Client Protocol agent on stdio, speaking ACP v1 or v2 as the agent
  negotiates (`maxProtocolVersion`, default 1).
- ARI installs no agent: the user installs it and names its `command`. The
  `acp-registry` flavor an earlier build offered, which installed ACP
  Registry agents, is gone; run a registry agent you installed with this
  driver instead.
- ACP clients typed by tables generated from ACP's v1 and v2 JSON Schemas,
  release `schema-v2.0.0-beta.3`, with a drift check (`codegen:acp:check`).
- Every agent process and version command gets the host's environment and
  the instance's `environment`, credentials included, minus only the host's
  `envPolicy.stripAmbient`, with the flavor's own variables over them. An
  earlier build passed none of the instance's `environment` on. This holds
  for every flavor: `grok`, `kiro`, `fx` and `antigravity`.
- v2 turns are accepted by the `session/prompt` response and settle on the
  `idle` `state_update`; updates are applied as upserts.
- Fork (draft `session/fork`) when the agent advertises it. A fork into
  another directory is asked of the agent (`forkAcrossDirectories` now
  defaults to `true`), and a refusal fails that fork with the agent's error.
  An earlier build refused such forks by default and, after one refusal of
  any kind, declared `crossCwd` off for the rest of the session.
- Permission replies use the agent's own option ids; `full_access` answers
  with the narrowest accepting option; enforcement is `client_boundary`.
- Config options keep `dependsOn` from `configDependencies`.
- Vendor `_meta` and unmapped updates pass through as `x:acp.meta` and
  `x:acp.update`; `ext("acp", "_method", params)` sends extension requests.
- Tool updates follow each version's rules: v2 keeps omitted fields and
  clears `null` ones; under v1, `null` changes nothing (v1 Tool Calls). A v2
  `user_message` updates the turn's user item, which shows only the host's
  own text, never the driver's first-prompt instructions. Resume applies the
  agent's current-state snapshot, so running work becomes a
  `provider_initiated` turn.
- `resumeThread` passes launch instructions on: `systemPrompt` on
  `session/resume`, `session/load` or the replacing `session/new`, the rest
  in the first prompt.
- A resume with `purpose: "history"` of a session the ARI session does not
  hold is `unsupported`, and nothing reaches the agent: ACP opens a session
  only to run it. An earlier build opened it as an interactive resume does.
- A resume replaces only a session the agent reports missing
  (`resource_not_found`). Any other error goes to the caller, and an agent
  that cannot resume at all refuses with `unsupported`; an earlier build
  started a fresh session for any of them. ACP has no error for a session
  another process holds, so the conformance kit's locked-session check does
  not apply.
- A resume of a session the ARI session holds applies its config and policy
  and passes its first-prompt instructions on; new MCP servers or a new
  system prompt, which ACP fixes when a session opens, are refused with
  `invalid_state`. An earlier build reported success and changed nothing.
- `switchModel` is declared only while the agent offers a `model` option;
  `sessionModel` is `process_per_session`.
- Tested against ACP protocol versions 1 and 2 (`testedVersions.range`
  `1 - 2`); `status()` gives an advisory after an agent answers another.
- A policy without a mode enforces none: every permission request goes to
  the host, and the agent keeps its own mode. The thread's `effectiveMode`
  reports the agent's mode id, from its `mode`-category option or v1
  `modes.currentModeId` and each update, as the agent names it. A flavor maps
  the ids it has evidence for (`harnessMode`). A cold resume of a known
  thread now records the resume's policy.
