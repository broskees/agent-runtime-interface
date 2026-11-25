// A host that hears back from startTurn late. The session it wraps answers
// startTurn only once the turn's text has reached the host and replay can go
// no further without the driver: the scenario runner has read, off the
// session's events, assistant text of the turn that startTurn started, the
// replay waits for the driver's next frame, and no event has come for a while.
// A busy machine can do the same: a driver may admit a turn and stream its
// text before the host's startTurn call returns. The replay tests wrap the
// replay's session in it to force that order.

import type { AriEvent } from "../../src/generated/events.ts";
import type { StartTurnInput, StartTurnResult } from "../../src/generated/session.ts";
import type { Session } from "../../src/runtime.ts";
import type { ReplaySequencer } from "./sequencer.ts";

/** How often the held startTurn looks again, and how many looks in a row must find nothing new. */
const LOOK_EVERY_MS = 10;
const QUIET_LOOKS = 5;

/** `session`, whose startTurn resolves only after the runner read the turn's text and replay waits on the driver. */
export function startTurnAfterItsText(session: Session, sequencer: ReplaySequencer): Session {
  const kinds = new Map<string, string>();
  const turnsWithText = new Set<string>();
  let eventsRead = 0;

  /** The runner has read `event`, and asks for the next one. */
  const read = (event: AriEvent): void => {
    eventsRead += 1;
    const body = event.body;
    if (body.type === "item.upsert" && body.item.kind !== undefined) kinds.set(body.item.id, body.item.kind);
    const itemId = body.type === "item.upsert" ? body.item.id : body.type === "item.delta" ? body.itemId : undefined;
    if (itemId === undefined || kinds.get(itemId) !== "assistant_message" || event.turnId === undefined) return;
    const text = (body.type === "item.delta" && body.field === "text" && body.chunk !== "") || (body.type === "item.upsert" && typeof body.item.text === "string" && body.item.text !== "");
    if (text) turnsWithText.add(event.turnId);
  };

  const events = async function* (options?: Parameters<Session["events"]>[0]): AsyncGenerator<AriEvent> {
    for await (const event of session.events(options)) {
      yield event;
      // The runner asked for the next event: it has acted on this one.
      read(event);
    }
  };

  const startTurn = async (input: StartTurnInput): Promise<StartTurnResult> => {
    const result = await session.startTurn(input);
    if (result.status !== "accepted") return result;
    await new Promise<void>((resolve) => {
      let quiet = 0;
      let seen = eventsRead;
      const look = (): void => {
        // A drift ends the hold: the runner reports it.
        if (sequencer.failure !== undefined) return resolve();
        quiet = turnsWithText.has(result.turnId) && sequencer.waitingForDriver() && eventsRead === seen ? quiet + 1 : 0;
        seen = eventsRead;
        if (quiet >= QUIET_LOOKS) return resolve();
        setTimeout(look, LOOK_EVERY_MS);
      };
      setTimeout(look, LOOK_EVERY_MS);
    });
    return result;
  };

  return new Proxy(session, {
    get(target, property) {
      if (property === "events") return events;
      if (property === "startTurn") return startTurn;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
