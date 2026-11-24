// @types/node 22 declares the global `Headers` but not the DOM library's
// `HeadersInit`. Two vendor SDKs' declarations name it, and the tests
// type-check those declarations (`skipLibCheck: false`):
//
// - @modelcontextprotocol/sdk, a peer of the Claude Agent SDK;
// - @connectrpc/connect, a dependency of @cursor/sdk.
//
// This is the same type the DOM library and undici give it. A global type
// alias may be declared only once in a program, so every test that needs it
// uses this one file.
type HeadersInit = NonNullable<ConstructorParameters<typeof Headers>[0]>;
