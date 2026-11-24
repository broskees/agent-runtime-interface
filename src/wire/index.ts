// `ari/wire`: ARI over newline-delimited JSON-RPC 2.0 on stdio (proposal
// §17.11). `serveDriver` serves a driver, as the `ari-driver` bin does;
// `connectDriver` and `startAriDriver` give a host a `Driver` whose instances
// and sessions run in another process. A host in another language needs only
// spec/v1/methods.json, the JSON Schema and docs/wire.md. Node-only: this
// subpath imports Node built-ins.

export { connectDriver } from "./client.ts";
export type { ConnectDriverOptions, WireDriverConnection, WireSession } from "./client.ts";

export { ARI_CALL_ERROR_CODE, WireConnection, callErrorOf, fromJsonRpcError, toJsonRpcError } from "./connection.ts";
export type { ConsumeOptions, WireConnectionOptions, WireRequestContext, WireTransport } from "./connection.ts";

export { CORE_METHODS, methodUnavailable, negotiateGrammarVersion, negotiateHandshake } from "./handshake.ts";
export type { NegotiatedVersions, RefusedMethod } from "./handshake.ts";

export { isDriver, isModulePath, loadDriver, pickDriver } from "./load-driver.ts";

export { METHOD_HELPERS, OPTIONAL_HOST_MEMBERS, OPTIONAL_INSTANCE_MEMBERS, OPTIONAL_SESSION_MEMBERS, WIRE_METHODS, defaultMethodVersions, wireMethod } from "./methods.ts";
export type { WireDirection, WireMethod } from "./methods.ts";

export { serveDriver } from "./server.ts";
export type { DriverServer, ServeDriverOptions } from "./server.ts";

export { defaultAriDriverCommand, startAriDriver, streamTransport } from "./stdio.ts";
export type { AriDriverProcess, StartAriDriverOptions } from "./stdio.ts";
