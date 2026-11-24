// @types/node 22 declares the global `Headers` but not the DOM library's
// `HeadersInit`, which the declarations of @modelcontextprotocol/sdk (a peer
// of the Claude Agent SDK, needed to type-check the SDK's own declarations)
// name. This is the same type the DOM library and undici give it.
type HeadersInit = NonNullable<ConstructorParameters<typeof Headers>[0]>;
