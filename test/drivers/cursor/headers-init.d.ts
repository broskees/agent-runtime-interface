// @types/node 22 declares the global `Headers` but not the DOM library's
// `HeadersInit`, which the declarations of @connectrpc/connect (a dependency
// of @cursor/sdk, needed to type-check the SDK's own declarations) name. This
// is the same type the DOM library and undici give it.
//
// The Claude driver's tests need the same global for another SDK. Only one
// declaration of it may exist in the program: when both are in one tree,
// keep one file and delete the other.
type HeadersInit = NonNullable<ConstructorParameters<typeof Headers>[0]>;
