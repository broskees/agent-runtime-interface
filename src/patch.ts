/**
 * The patch form of an entity: every field optional, and `null` clears it.
 * `ThreadPatch`, `TurnPatch`, `ItemPatch`, `RequestPatch`, `SubagentPatch` and
 * `PlanPatch` are the schema's concrete patch types.
 */
export type Patch<T> = { [Key in keyof T]?: T[Key] | null };

/**
 * Applies `patch` to `target` with ACP v2 patch semantics and returns a new
 * object:
 *
 * - a field the patch omits (or sets to `undefined`) is unchanged;
 * - a field the patch sets to `null` is cleared: the result has no such field;
 * - any other value replaces the field.
 *
 * Nested objects and arrays are replaced whole, never merged: a patch carrying
 * `tool: { name: "grep" }` replaces the entire `tool` object, and a patch
 * carrying `todos: [...]` replaces the entire list. Only the top level of the
 * entity is patched. Fields the patch carries that the target does not know are
 * kept, so newer fields survive older code.
 *
 * Pass `undefined` as `target` to open a new entity from its first patch.
 * Neither `target` nor `patch` is mutated; nested values are shared with the
 * inputs, not copied. Streaming text appends through `item.delta` events, not
 * through patches.
 */
export function applyPatch<T extends object>(target: T | undefined, patch: Patch<T>): T {
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) {
      delete result[key];
      continue;
    }
    result[key] = value;
  }
  return result as T;
}
