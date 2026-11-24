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
// 3. one `deny` per host MCP entry of every other thread on the same server.
//    MCP tool calls ask for the permission `<server>_<tool>`, with the server
//    and tool names sanitized to `[a-zA-Z0-9_-]` (1.x
//    `mcp/catalog.ts` `toolName`, 2.x `core/src/tool/mcp.ts` `name`), so the
//    rule `<other server>_*` denies every tool of that entry. A session's deny
//    is checked before any saved "always" grant (2.x `evaluateInput`), so
//    another thread's grant cannot reopen it.
// The deny rules come last so neither the mode nor the host can unlock
// another thread's tools.

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

/** Denies every tool of each of `others`, the MCP entries this thread does not own. */
export function isolationRules(others: Iterable<string>): NativeRule[] {
  return [...new Set([...others].map(sanitizeMcpName))].sort().map((name) => ({ action: `${name}_*`, resource: "*", effect: "deny" as const }));
}

/**
 * The entry names whose tool names OpenCode cannot keep apart: `a` and `a_b`
 * give tool names that `a_*` matches for both. A thread's deny of the other's
 * entry would then deny its own tools too, or the reverse.
 */
export function collidingName(name: string, others: Iterable<string>): string | undefined {
  const own = sanitizeMcpName(name);
  for (const other of others) {
    const sanitized = sanitizeMcpName(other);
    if (sanitized === own || own.startsWith(`${sanitized}_`) || sanitized.startsWith(`${own}_`)) return other;
  }
  return undefined;
}

export function sessionRules(mode: RuntimeMode, generation: Generation, hostRules: readonly NativeRule[], others: Iterable<string>): NativeRule[] {
  return [...modeRules(mode, generation), ...hostRules, ...isolationRules(others)];
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
