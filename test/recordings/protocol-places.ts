// Protocol words by place: where the pinned types of a driver's native side
// put a string literal in an inbound frame. The sanitiser keeps the user name
// in an inbound string only when the value is one of the words the pinned
// types allow at that very spot, so `type: "user"` stays on an account named
// `user` where an SDK message's `type` is, and `name: "memory"` goes in an
// opaque tool result, whose fields the types do not describe.
//
// A place is one spot the pinned types describe: the set of object types a
// value there can have. It is named by the first path of keys that reaches it
// from the frame, keys sorted at each step: "" is the frame itself,
// "message" the frame's `message`, "message.params" that message's `params`,
// and so on; an array's elements share the array's place. A place lists, for
// each key an object there can have, the words the types allow as the key's
// string value, and the place of the key's object value. ANY_KEY stands for
// every key a type there declares with an index signature or
// `additionalProperties`. A value with no place (a type of `unknown`, `any` or
// `object`, or JSON Schema `true`) is opaque: nothing below it is a protocol
// word.
//
// Each driver kit derives its words from its pinned sources with
// `placeProtocolWords` (./claude, ./opencode, ./acp and ./codex
// derive-protocol-words.ts), commits the result as protocol-words.ts, and
// test/recordings/protocol-words.test.ts checks the two still agree.

/** One key at one place: the words its string value may be, and the place of its object value. */
export interface ProtocolSlot {
  readonly words?: readonly string[];
  readonly place?: string;
}

/** For each place, its keys' slots. */
export type ProtocolWords = { readonly [place: string]: { readonly [key: string]: ProtocolSlot } };

/** The place of the frame itself. */
export const FRAME_PLACE = "";

/** The slot of every key a type declares by an index signature or `additionalProperties`. */
export const ANY_KEY = "*";

/** The slot of `key` at `place`: its own, else the place's ANY_KEY slot. Undefined at an opaque place. */
export function slotAt(words: ProtocolWords, place: string | undefined, key: string): ProtocolSlot | undefined {
  if (place === undefined) return undefined;
  const slots = words[place];
  return slots?.[key] ?? slots?.[ANY_KEY];
}

/** The slot an object value of `slot` opens, keyed for `key` of that object. */
export function slotBelow(words: ProtocolWords, slot: ProtocolSlot | undefined, key: string): ProtocolSlot | undefined {
  return slot?.place === undefined ? undefined : slotAt(words, slot.place, key);
}

/** Whether `value` is a protocol word of the slot `path` reaches from the frame (`["message", "type"]`). */
export function isProtocolWordAt(words: ProtocolWords, path: readonly string[], value: string): boolean {
  let slot: ProtocolSlot | undefined;
  path.forEach((key, index) => {
    slot = index === 0 ? slotAt(words, FRAME_PLACE, key) : slotBelow(words, slot, key);
  });
  return slot?.words?.includes(value) === true;
}

/** For each named key that holds words at some place (ANY_KEY aside), every word it may hold: what docs/recordings.md lists, key by key. */
export function protocolKeys(words: ProtocolWords): { [key: string]: string[] } {
  const byKey = new Map<string, Set<string>>();
  for (const slots of Object.values(words)) {
    for (const [key, slot] of Object.entries(slots)) {
      if (slot.words === undefined || key === ANY_KEY) continue;
      const own = byKey.get(key) ?? new Set<string>();
      for (const word of slot.words) own.add(word);
      byKey.set(key, own);
    }
  }
  return Object.fromEntries([...byKey.keys()].sort().map((key) => [key, [...byKey.get(key)!].sort()]));
}

/**
 * How a set of pinned sources describes values, for `placeProtocolWords`: a
 * value node (a type, a schema) holds words and object shapes; a shape has
 * fields, and maybe a type for every other key.
 */
export interface ProtocolGraph<Shape, Value> {
  /** The string literals `value` allows, through unions and array elements. */
  words(value: Value): Iterable<string>;
  /** The object shapes `value` can be, through unions, intersections and array elements. */
  shapes(value: Value): Iterable<Shape>;
  /** The declared fields of `shape`, by key. */
  fields(shape: Shape): ReadonlyMap<string, readonly Value[]>;
  /** The type of every key `shape` declares by an index signature or `additionalProperties`, if any. */
  anyKey(shape: Shape): readonly Value[] | undefined;
}

/**
 * Walks the pinned sources from the frame's fields (`roots`: for each field
 * of an inbound frame, what it carries) and returns every place the frame's
 * values can reach, breadth first, keys sorted, so the result is the same for
 * the same sources whatever order the sources list their members in. `extra`
 * adds words the sources give some other way (ACP's method names), by the
 * path of keys from the frame.
 */
export function placeProtocolWords<Shape, Value>(roots: { readonly [field: string]: readonly Value[] }, graph: ProtocolGraph<Shape, Value>, extra: ReadonlyArray<{ readonly path: readonly string[]; readonly words: readonly string[] }> = []): ProtocolWords {
  const ids = new Map<Shape, number>();
  const idOf = (shape: Shape): number => {
    let id = ids.get(shape);
    if (id === undefined) {
      id = ids.size;
      ids.set(shape, id);
    }
    return id;
  };
  const byShapes = new Map<string, string>();
  const shapesOfPlace = new Map<string, Shape[]>();
  const queue: string[] = [];
  const result: { [place: string]: { [key: string]: ProtocolSlot } } = {};

  /** The place of a set of shapes reached first at `path`: one name per distinct set. */
  const placeFor = (shapes: Shape[], path: string): string => {
    const key = [...new Set(shapes.map(idOf))].sort((a, b) => a - b).join(",");
    const known = byShapes.get(key);
    if (known !== undefined) return known;
    let name = path;
    for (let suffix = 2; shapesOfPlace.has(name); suffix += 1) name = `${path}#${suffix}`;
    byShapes.set(key, name);
    shapesOfPlace.set(name, shapes);
    queue.push(name);
    return name;
  };

  const slotOf = (values: readonly Value[], path: string): ProtocolSlot => {
    const words = [...new Set(values.flatMap((value) => [...graph.words(value)]))].sort();
    const shapes = [...new Set(values.flatMap((value) => [...graph.shapes(value)]))];
    const place = shapes.length === 0 ? undefined : placeFor(shapes, path);
    return { ...(words.length === 0 ? {} : { words }), ...(place === undefined ? {} : { place }) };
  };

  const join = (place: string, key: string): string => (place === FRAME_PLACE ? key : `${place}.${key}`);

  const frame: { [key: string]: ProtocolSlot } = {};
  for (const field of Object.keys(roots).sort()) frame[field] = slotOf(roots[field]!, field);
  result[FRAME_PLACE] = frame;

  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const shapes = shapesOfPlace.get(next)!;
    const keys = [...new Set(shapes.flatMap((shape) => [...graph.fields(shape).keys()]))].sort();
    const open = shapes.flatMap((shape) => graph.anyKey(shape) ?? []);
    const opens = shapes.some((shape) => graph.anyKey(shape) !== undefined);
    const slots: { [key: string]: ProtocolSlot } = {};
    for (const key of keys) {
      const values = shapes.flatMap((shape) => graph.fields(shape).get(key) ?? graph.anyKey(shape) ?? []);
      const slot = slotOf(values, join(next, key));
      // A key with nothing to say is left out, unless the place has an ANY_KEY slot it would otherwise fall back to.
      if (slot.words !== undefined || slot.place !== undefined || opens) slots[key] = slot;
    }
    if (opens) slots[ANY_KEY] = slotOf(open, join(next, ANY_KEY));
    result[next] = slots;
  }

  for (const entry of extra) {
    let place = FRAME_PLACE;
    entry.path.forEach((key, index) => {
      const slots = result[place] as { [key: string]: ProtocolSlot } | undefined;
      if (slots === undefined) throw new Error(`no place ${place} on the way to ${entry.path.join(".")}`);
      const slot = slots[key] ?? {};
      if (index === entry.path.length - 1) {
        slots[key] = { ...slot, words: [...new Set([...(slot.words ?? []), ...entry.words])].sort() };
        return;
      }
      if (slot.place === undefined) throw new Error(`${entry.path.slice(0, index + 1).join(".")} opens no place`);
      place = slot.place;
    });
  }

  const sorted: { [place: string]: { [key: string]: ProtocolSlot } } = {};
  for (const place of Object.keys(result).sort()) sorted[place] = Object.fromEntries(Object.keys(result[place]!).sort().map((key) => [key, result[place]![key]!]));
  return sorted;
}
