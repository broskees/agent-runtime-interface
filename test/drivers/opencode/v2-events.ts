// Checks OpenCode 2.x events against OpenCode's own event schema. The 2.1.2
// OpenAPI document describes the `/api/event` stream only as
// `contentMediaType: application/json`, so the schema is the one OpenCode's
// server encodes with: `OpenCodeEvent` from `@opencode/protocol` 2.1.2
// (`groups/event`), an Effect schema decoded with the Effect version that
// package depends on (effect 4.0.1), not the repository's own Effect.

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const PROTOCOL_EVENTS: string = "@opencode/protocol/groups/event";

interface EffectSchemaModule {
  decodeUnknownExit(schema: unknown): (value: unknown) => { _tag: string; cause?: unknown };
}

let loaded: Promise<(value: unknown) => string[]> | undefined;

/** A checker for 2.x events: the problems with one event, none when it decodes. */
export function v2EventChecker(): Promise<(value: unknown) => string[]> {
  loaded ??= (async () => {
    const entry = import.meta.resolve(PROTOCOL_EVENTS);
    const events = (await import(PROTOCOL_EVENTS)) as { OpenCodeEvent: unknown };
    // The Effect the protocol package itself resolves (its own dependency, effect 4.0.1).
    const schemaFile = createRequire(entry).resolve("effect/Schema");
    const Schema = (await import(pathToFileURL(schemaFile).href)) as EffectSchemaModule;
    const decode = Schema.decodeUnknownExit(events.OpenCodeEvent);
    return (value: unknown): string[] => {
      const exit = decode(value);
      if (exit._tag === "Success") return [];
      const type = typeof value === "object" && value !== null ? String((value as { type?: unknown }).type) : typeof value;
      return [`2.x event ${type} does not match OpenCodeEvent: ${String(exit.cause).slice(0, 600)}`];
    };
  })();
  return loaded;
}
