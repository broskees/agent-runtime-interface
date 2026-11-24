// @types/node 22 declares the global `TextDecoder` but not the DOM library's
// `TextDecoderOptions`, which the declarations of effect 4.0.1 (a dependency
// of @opencode/client's schema package, needed to type-check the client's own
// declarations) name. This is the same type the DOM library gives it.
type TextDecoderOptions = NonNullable<ConstructorParameters<typeof TextDecoder>[1]>;
