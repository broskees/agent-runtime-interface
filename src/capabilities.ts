import { callErrors } from "./errors.ts";
import type { Capabilities } from "./generated/capabilities.ts";

/**
 * The value at a dot-separated capability path, such as `threads.fork.fromTurn`
 * or `runtimePolicy.modes.full_access`. Undefined when any segment is missing.
 */
export function capabilityValue(capabilities: Capabilities, path: string): unknown {
  let node: unknown = capabilities;
  for (const segment of path.split(".")) {
    if (typeof node !== "object" || node === null || Array.isArray(node) || !Object.hasOwn(node, segment)) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/**
 * True when the capability at `path` is on.
 *
 * Without `expected`, a value is on when it is `true`, an object whose
 * `supported` is `true`, a non-empty array, or a string other than `""` and
 * `"none"` (so `identity.requestIds` is on for `strong` and `weak`). Anything
 * else is off, including a missing field.
 *
 * With `expected`, the path is on when its value equals `expected` or is an
 * array containing it, for example
 * `hasCapability(caps, "context.instructionChannels", "system")`.
 */
export function hasCapability(capabilities: Capabilities, path: string, expected?: unknown): boolean {
  const value = capabilityValue(capabilities, path);
  if (expected !== undefined) {
    return value === expected || (Array.isArray(value) && value.includes(expected));
  }
  if (value === true) return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value !== "" && value !== "none";
  if (typeof value === "object" && value !== null) return (value as { supported?: unknown }).supported === true;
  return false;
}

/**
 * Throws the `unsupported` call error naming `path` when the capability is off
 * (see `hasCapability` for what on means). Returns normally when it is on.
 */
export function requireCapability(capabilities: Capabilities, path: string, expected?: unknown): void {
  if (hasCapability(capabilities, path, expected)) return;
  const wanted = expected === undefined ? "" : ` (${JSON.stringify(expected)})`;
  throw callErrors.unsupported(path, `Capability ${path}${wanted} is not supported`);
}
