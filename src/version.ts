// The contract's own version numbers (spec/v1/README.md, "Versions"). They are
// independent of the npm package version.

/** The ARI contract version, sent as `ariVersion` in capabilities and the handshake. */
export const ARI_VERSION = "1.0.0";

/** The event grammar versions this package understands, as an ascending `[min, max]` range. */
export const GRAMMAR_VERSIONS: readonly [min: number, max: number] = [1, 1];

/** The persistence version of stored session handles and event journals. */
export const PERSISTENCE_VERSION: { readonly major: number; readonly minor: number } = { major: 1, minor: 0 };
