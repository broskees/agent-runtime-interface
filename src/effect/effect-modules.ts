// The one place `ari/effect` loads `effect`, the optional peer dependency.
//
// The repository rules forbid a static import of `effect` anywhere in src/
// and allow built files to load it only through `import()`, so that no other
// subpath can pull it in by accident. This module therefore loads the Effect
// modules it needs with a top-level `await import(...)`. Importing `ari/effect`
// waits for them; importing any other subpath never reaches this file.
//
// When `effect` is missing, or is older than 4.x, importing `ari/effect` fails
// with an error that names the package and the version range to install.

const EFFECT_RANGE = "^4.0.0";

function isMissingEffect(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") && typeof message === "string" && message.includes("'effect");
}

async function loadEffect() {
  try {
    const [Context, Data, Effect, Layer, Schema, Stream] = await Promise.all([
      import("effect/Context"),
      import("effect/Data"),
      import("effect/Effect"),
      import("effect/Layer"),
      import("effect/Schema"),
      import("effect/Stream"),
    ]);
    // `Context.Service` is new in Effect 4; Effect 3 has `Context.Tag` instead.
    if (typeof Context.Service !== "function") {
      throw new Error(`ari/effect needs effect ${EFFECT_RANGE}; the installed effect is older. Install effect@${EFFECT_RANGE}.`);
    }
    return { Context, Data, Effect, Layer, Schema, Stream };
  } catch (error) {
    if (isMissingEffect(error)) {
      throw new Error(
        `ari/effect needs the optional peer dependency "effect" (${EFFECT_RANGE}), which is not installed. Install effect@${EFFECT_RANGE} to use ari/effect.`,
        { cause: error },
      );
    }
    throw error;
  }
}

export const { Context, Data, Effect, Layer, Schema, Stream } = await loadEffect();
