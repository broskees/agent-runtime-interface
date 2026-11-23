// Deterministic ids. Every ARI entity id must follow from native data alone:
// the same native input gives the same id after a restart or a replay, in any
// process. `deriveId` hashes the entity kind, the driver's `identityVersion`,
// an enclosing scope and the native reference, using the rule its strength
// sets:
//
//   strong  the native id alone (ordinal and fingerprint are ignored).
//   weak    the native id (which may be null) plus the ordinal and fingerprint;
//           at least one of the two is required.
//   none    no native id: the ordinal within the scope, plus the fingerprint
//           when given. The ordinal is required.
//
// Changing `identityVersion` changes every id, so a driver that changes how it
// derives ids bumps it and persisted history keeps its old ids. An id looks
// like `item_` followed by 32 hex digits (128 bits of SHA-256).

import type { NativeRef } from "../generated/common.ts";
import { sha256Hex } from "./sha256.ts";

export interface DeriveIdInput {
  /** The entity kind, for example `thread`, `turn`, `item` or `request`. It prefixes the id. */
  readonly kind: string;
  readonly native: NativeRef;
  /** The driver's id derivation version, a non-negative integer. */
  readonly identityVersion: number;
  /**
   * The enclosing entity's ARI id (for example the thread id for a turn, or
   * the turn id for an item), so that native ids and ordinals that repeat in
   * different scopes give different ids. Empty for top-level entities.
   */
  readonly scope?: string;
}

/** Derives the deterministic ARI id for a native entity. Throws a `TypeError` when the native reference does not meet its strength's rule. */
export function deriveId(input: DeriveIdInput): string {
  const { kind, native, identityVersion } = input;
  if (kind === "") throw new TypeError("deriveId: kind must not be empty");
  if (!Number.isInteger(identityVersion) || identityVersion < 0) {
    throw new TypeError(`deriveId: identityVersion must be a non-negative integer, got ${String(identityVersion)}`);
  }
  if (native.ordinal !== undefined && (!Number.isInteger(native.ordinal) || native.ordinal < 0)) {
    throw new TypeError(`deriveId: ordinal must be a non-negative integer, got ${String(native.ordinal)}`);
  }

  let material: unknown[];
  if (native.strength === "strong") {
    if (typeof native.id !== "string") throw new TypeError(`deriveId: a strong native reference for ${kind} needs a native id`);
    material = ["strong", native.id];
  } else if (native.strength === "weak") {
    if (native.ordinal === undefined && native.fingerprint === undefined) {
      throw new TypeError(`deriveId: a weak native reference for ${kind} needs an ordinal or a fingerprint`);
    }
    material = ["weak", native.id, native.ordinal ?? null, native.fingerprint ?? null];
  } else if (native.strength === "none") {
    if (native.ordinal === undefined) throw new TypeError(`deriveId: a native reference of strength none for ${kind} needs an ordinal`);
    material = ["none", native.ordinal, native.fingerprint ?? null];
  } else {
    throw new TypeError(`deriveId: unknown native reference strength "${native.strength}"`);
  }

  const key = JSON.stringify(["ari.id", identityVersion, kind, input.scope ?? "", ...material]);
  return `${kind}_${sha256Hex(key).slice(0, 32)}`;
}

/**
 * JSON text for `value` with object keys sorted and `undefined` fields left
 * out, so equal data always gives equal text.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((element) => canonicalJson(element)).join(",")}]`;
  const fields = Object.keys(value)
    .filter((key) => (value as { [key: string]: unknown })[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as { [key: string]: unknown })[key])}`);
  return `{${fields.join(",")}}`;
}

/** A stable content fingerprint for `NativeRef.fingerprint`: 32 hex digits of SHA-256 over the canonical JSON of `value`. */
export function contentFingerprint(value: unknown): string {
  return sha256Hex(canonicalJson(value)).slice(0, 32);
}

/** Hands out ordinals 0, 1, 2, ... per scope, for entities whose native reference is `weak` or `none`. */
export class OrdinalCounter {
  readonly #next = new Map<string, number>();

  /** The next ordinal in `scope`. */
  next(scope: string): number {
    const ordinal = this.#next.get(scope) ?? 0;
    this.#next.set(scope, ordinal + 1);
    return ordinal;
  }
}
