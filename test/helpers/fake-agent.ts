// A fake agent for the tests that kill an agent's owner: a `/bin/sh` that
// starts a long-lived grandchild in its own process group (a `/bin/sleep` that
// ignores SIGHUP and never reads stdin), prints the grandchild's pid on one
// line, and then waits. It needs nothing on PATH, so it also runs under the
// standalone `ari-driver` with no Node or Bun around.

/** How the fake agent behaves once it has started its grandchild. */
export type FakeAgentKind =
  /** Waits for its grandchild; SIGTERM ends both. */
  | "plain"
  /** Like `plain`, but the agent and its grandchild ignore SIGTERM too, so only SIGKILL ends them. */
  | "ignore-term"
  /** Exits on its own once its stdin closes, leaving its grandchild behind in its group. */
  | "exit-on-stdin-close";

/** The arguments of `/bin/sh` that run the fake agent. */
export function fakeAgentArgs(kind: FakeAgentKind): string[] {
  const ignored = kind === "ignore-term" ? "HUP TERM" : "HUP";
  const then = kind === "exit-on-stdin-close" ? "read -r _; exit 0" : "wait";
  // Signals a shell ignores are ignored by what it starts, so the grandchild ignores them too.
  return ["-c", `trap '' ${ignored}; /bin/sleep 3600 </dev/null >/dev/null 2>&1 & echo "$!"; ${then}`];
}

/** Reads `stream` up to its first newline and returns that line, leaving the stream open. */
export async function readFirstLine(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  const iterator = stream[Symbol.asyncIterator]();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const next = await iterator.next();
    if (next.done === true) throw new Error(`the stream ended before a full line: ${JSON.stringify(text)}`);
    text += typeof next.value === "string" ? next.value : decoder.decode(next.value, { stream: true });
    const newline = text.indexOf("\n");
    if (newline !== -1) return text.slice(0, newline);
  }
}
