// Which runtime a test's child process runs on.
//
// `process.execPath` is the runtime that runs the test: Node under
// `pnpm run test` (`node --test`), Bun under `pnpm run test:bun` (`bun test`).
// A test whose child needs Node itself starts `NODE_EXECUTABLE` instead: the
// child uses a Node feature Bun 1.3 lacks (the module hooks of `node:module`,
// Node's error codes), or the test says it runs the package under Node.

/** The running Node under `node --test`; under Bun, the `node` on PATH. */
export const NODE_EXECUTABLE = process.versions["bun"] === undefined ? process.execPath : "node";
