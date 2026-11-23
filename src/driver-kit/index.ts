// `ari/driver-kit`: primitives every driver reuses. The event sequencer with
// `fromSeq` replay, deterministic ids, NDJSON framing, a JSON-RPC 2.0 peer,
// byte-safe truncation and AbortSignal-based cleanup. It imports no Node
// built-in, so it also runs in Bun, Deno and browsers.

export { EventSequencer } from "./sequencer.ts";
export type { EventSequencerOptions, SequencerEventInput, SequencerEventsOptions } from "./sequencer.ts";

export { OrdinalCounter, canonicalJson, contentFingerprint, deriveId } from "./ids.ts";
export type { DeriveIdInput } from "./ids.ts";
export { sha256, sha256Hex } from "./sha256.ts";

export { NdjsonDecoder, encodeNdjson, readNdjson } from "./ndjson.ts";
export type { NdjsonRecord } from "./ndjson.ts";

export { JSON_RPC_ERROR_CODES, JsonRpcError, JsonRpcPeer } from "./json-rpc.ts";
export type {
  JsonRpcCallOptions,
  JsonRpcErrorObject,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcPeerOptions,
  JsonRpcRequest,
  JsonRpcRequestContext,
  JsonRpcResponse,
} from "./json-rpc.ts";

export { truncateUtf8 } from "./truncate.ts";
export type { TruncatedText } from "./truncate.ts";

export { CleanupScope } from "./cleanup.ts";
