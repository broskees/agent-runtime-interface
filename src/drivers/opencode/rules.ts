// OpenCode enforces ARI's runtime modes natively, through each session's own
// permission rules (1.x `Session.permission`, 2.x `Session.permissions`).
// Both generations evaluate the agent's rules and then the session's, and the
// last rule that matches a permission and resource wins (1.x
// `permission/index.ts` `evaluate`, 2.x `core/src/permission.ts` `evaluate`,
// both with `util/wildcard.ts` `match`: `*` matches anything, `?` one
// character).
//
// A session's rules are, in this order:
// 1. the runtime mode's rules;
// 2. rules the host set through the `opencode.permissionRules` extension;
// 3. `deny` rules for each host MCP entry of every other thread on the same
//    server, one for each way OpenCode lets a session reach an entry:
//    - its tools: MCP tool calls ask for the permission `<server>_<tool>`,
//      with the server and tool names sanitized to `[a-zA-Z0-9_-]` (1.x
//      `mcp/catalog.ts` `toolName`, 2.x `core/src/tool/mcp.ts` `name`), so
//      `<other server>_*` denies every tool of that entry; 1.x also leaves a
//      tool denied for every resource out of the model's tools
//      (`permission/index.ts` `disabled`);
//    - its resources: 1.x lists and reads them under the permission `read`,
//      for `mcp:<server>:*` and `mcp:<server>:<uri>` (`session/tools.ts`);
//      2.x under `opencode_list_mcp_resources` for the server's name and
//      `opencode_read_mcp_resource` for `<server>:<uri>`
//      (`core/src/tool/plugin/mcp-resource.ts`). A listing of every server
//      names them all, so it is denied while another thread's entry is there.
//    A 2.x session's deny is checked before any saved "always" grant (2.x
//    `evaluateInput`), so another thread's grant cannot reopen it. 1.x checks
//    its in-memory grants after the session's rules (1.x `ask`); only a shared
//    external 1.x server has that, and session.ts offers no "always" there for
//    an MCP resource read.
// The deny rules come last so neither the mode nor the host can unlock
// another thread's entry.

import type { RuntimeMode } from "../../generated/config.ts";
import type { NativeRule } from "./native.ts";
import type { Generation } from "./server.ts";

/** OpenCode's permission name for shell commands: 1.x kept `bash` (1.x `tool/shell/id.ts`), 2.x calls it `shell`. */
export function shellPermission(generation: Generation): string {
  return generation === 1 ? "bash" : "shell";
}

const rule = (action: string, effect: NativeRule["effect"]): NativeRule => ({ action, resource: "*", effect });

/** The rules that enforce one ARI runtime mode. */
export function modeRules(mode: RuntimeMode, generation: Generation): NativeRule[] {
  const shell = shellPermission(generation);
  switch (mode) {
    case "full_access":
      return [rule("*", "allow")];
    case "read_only":
      return [rule(shell, "deny"), rule("edit", "deny"), rule("external_directory", "ask")];
    case "auto_accept_edits":
      return [rule(shell, "ask"), rule("edit", "allow"), rule("external_directory", "ask")];
    case "approval_required":
      return [rule(shell, "ask"), rule("edit", "ask"), rule("external_directory", "ask")];
    default:
      throw new Error(`OpenCode has no rules for runtime mode ${mode}`);
  }
}

/** How OpenCode names an MCP server in its tool and permission names. */
export function sanitizeMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Denies each of `others`, the MCP entries this thread does not hold, every way OpenCode reaches an entry: its tools and its resources. */
export function isolationRules(others: Iterable<string>, generation: Generation): NativeRule[] {
  const deny = (action: string, resource: string): NativeRule => ({ action, resource, effect: "deny" });
  const names = [...new Set(others)].sort();
  const tools = [...new Set(names.map(sanitizeMcpName))].map((name) => deny(`${name}_*`, "*"));
  const resources = names.flatMap((name) => (generation === 1 ? [deny("read", `mcp:${name}:*`)] : [deny("opencode_list_mcp_resources", name), deny("opencode_read_mcp_resource", `${name}:*`)]));
  return [...tools, ...resources];
}

/**
 * The entry name of `others` that OpenCode's rules cannot keep apart from
 * `name`, if any. `a` and `a_b` give tool names that `a_*` matches for both;
 * `a` and `a:b` give resources that `a:*` (2.x) or `mcp:a:*` (1.x) matches for
 * both; a `*` or `?` in a name is a wildcard in the resource rules. A thread's
 * deny of the other's entry would then deny its own too, or the reverse. The
 * same name twice is the registry's matter (pool.ts), not a collision.
 */
export function collidingName(name: string, others: Iterable<string>): string | undefined {
  const own = sanitizeMcpName(name);
  for (const other of others) {
    if (other === name) continue;
    const sanitized = sanitizeMcpName(other);
    if (sanitized === own || own.startsWith(`${sanitized}_`) || sanitized.startsWith(`${own}_`)) return other;
    if (name.startsWith(`${other}:`) || other.startsWith(`${name}:`) || /[*?]/.test(name) || /[*?]/.test(other)) return other;
  }
  return undefined;
}

export function sessionRules(mode: RuntimeMode, generation: Generation, hostRules: readonly NativeRule[], others: Iterable<string>): NativeRule[] {
  return [...modeRules(mode, generation), ...hostRules, ...isolationRules(others, generation)];
}

/** A subagent's rules: the ones OpenCode gave it when it created it, then the current denies of every other thread's entries. */
export function childRules(created: readonly NativeRule[], generation: Generation, others: Iterable<string>): NativeRule[] {
  return [...created, ...isolationRules(others, generation)];
}

/** OpenCode's wildcard match (1.x and 2.x `util/wildcard.ts` `match`): `*` is any text, `?` one character, and a trailing ` *` also matches nothing after the word. */
export function wildcardMatch(input: string, pattern: string): boolean {
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, "s").test(input.replaceAll("\\", "/"));
}

/** The effect of the last of `rules` that matches `action` and `resource`, as OpenCode evaluates them; undefined when none matches. */
export function lastMatchingEffect(action: string, resource: string, rules: readonly NativeRule[]): NativeRule["effect"] | undefined {
  return rules.findLast((rule) => wildcardMatch(action, rule.action) && wildcardMatch(resource, rule.resource))?.effect;
}

/** Rules as 1.x's `PermissionRuleset` (`permission`, `pattern`, `action`). */
export function toV1Rules(rules: readonly NativeRule[]): Array<{ permission: string; pattern: string; action: NativeRule["effect"] }> {
  return rules.map((entry) => ({ permission: entry.action, pattern: entry.resource, action: entry.effect }));
}

export function fromV1Rules(value: unknown): NativeRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: { permission?: unknown; pattern?: unknown; action?: unknown }) =>
    typeof entry?.permission === "string" && typeof entry.pattern === "string" && (entry.action === "allow" || entry.action === "deny" || entry.action === "ask")
      ? [{ action: entry.permission, resource: entry.pattern, effect: entry.action }]
      : [],
  );
}

export function fromV2Rules(value: unknown): NativeRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: { action?: unknown; resource?: unknown; effect?: unknown }) =>
    typeof entry?.action === "string" && typeof entry.resource === "string" && (entry.effect === "allow" || entry.effect === "deny" || entry.effect === "ask")
      ? [{ action: entry.action, resource: entry.resource, effect: entry.effect }]
      : [],
  );
}
