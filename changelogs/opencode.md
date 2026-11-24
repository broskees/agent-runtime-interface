# Changelog: `ari/drivers/opencode`

## Unreleased

- First version of the OpenCode driver, for OpenCode 1.x servers through
  `@opencode-ai/sdk` (tested with 1.19.6) and 2.x servers through
  `@opencode/client` (tested with 2.1.2), both optional peers loaded with a
  dynamic `import()`.
- Chooses the runtime by the server's version: `opencode --version`, or an
  external server's `GET /api/info` (2.x) or `GET /global/health` (1.x).
- Session models: `process_per_thread` (1.x, one `opencode serve` per thread),
  `process_per_instance` (2.x, one per instance) and `external` with
  `externallyOwned: true` for a configured `serverUrl`, which the driver never
  stops.
- Runtime modes as native OpenCode session permission rules; each thread's
  host MCP entry under the host's name, and a deny rule for every other
  thread's entry on a shared server.
- "Always" approvals report `scope: "project"`; a full_access auto-reply
  picks "once"; under full_access OpenCode asks nothing.
- 2.x steering through OpenCode's inbox (`delivery: "steer"`,
  `resume: false`), with `prompt_required` for a steer that missed its turn.
- Subagents (child sessions) with their own threads, questions and forms as
  `user_input` requests, 1.x todo lists.
- The `opencode.permissionRules` extension (`get`, `set`).
