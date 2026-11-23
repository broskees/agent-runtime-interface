// `ari/node`: reference host services for Node (proposal §10). Per-instance
// paths, process spawning with environment rules and process-group cleanup,
// file-backed secrets, coordination leases, diagnostics with a byte budget and
// redaction, a loopback sign-in callback server, the atomic managed adapter
// installer, and `createNodeHostServices`, which assembles all of them into
// one `HostServices` for an instance. Node-only: this subpath imports Node
// built-ins.

export { startCallbackServer } from "./callbacks.ts";
export type { CallbackServer, CallbackServerOptions } from "./callbacks.ts";

export { createCoordination } from "./coordination.ts";
export type { Coordination, CoordinationOptions } from "./coordination.ts";

export { createDiagnostics, DEFAULT_DIAGNOSTIC_ENTRY_BYTES } from "./diagnostics.ts";
export type { DiagnosticRecord, Diagnostics, DiagnosticsOptions } from "./diagnostics.ts";

export { createNodeHostServices } from "./host-services.ts";
export type { NodeHostServices, NodeHostServicesOptions } from "./host-services.ts";

export { createAdapterInstaller, DEFAULT_HANDSHAKE_TIMEOUT_MS, npmRegistryFetch } from "./installer.ts";
export type {
  AdapterInstaller,
  AdapterInstallerOptions,
  AdapterLease,
  CleanupOptions,
  InstalledAdapter,
  NpmRegistryFetchOptions,
  TarballFetch,
  TarballRequest,
} from "./installer.ts";

export { createInstanceDirectories, instancePaths } from "./paths.ts";

export {
  buildChildEnvironment,
  createProcessService,
  DEFAULT_KILL_GRACE_MS,
  matchesStripRule,
  resolveExecutable,
} from "./process.ts";
export type { Environment, ProcessService, ProcessServiceOptions } from "./process.ts";

export { createFileSecrets } from "./secrets.ts";
export type { FileSecrets } from "./secrets.ts";

export { extractTarball } from "./tar.ts";
export type { ExtractOptions } from "./tar.ts";
