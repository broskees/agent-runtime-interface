// Builds file paths from a path a host or a PATH entry gave, without
// rewriting that path.
//
// Linux and macOS read `a/link/../b` by following `link` first and then going
// up, so it can name a directory other than `a/b`. `path.join`,
// `path.resolve` and `path.normalize` collapse `..` in the string before the
// operating system sees it, and so can name a different file than the one the
// host meant. Every path `ari/node` builds from a given path goes through
// `appendToPath`, which keeps the given part exactly as given.

import * as path from "node:path";

const isWindows = process.platform === "win32";

/**
 * `base` with `segments` appended, naming what the operating system will
 * read. `base` is kept as given; a relative `base` is prefixed with `cwd`.
 * Each segment must be a single name this module chose or validated: no
 * separator, no `.` and no `..`. On Windows the operating system itself
 * collapses `..` in the string, so `path.resolve` names the same file there.
 */
export function appendToPath(base: string, segments: readonly string[], cwd: string = process.cwd()): string {
  if (isWindows) return path.resolve(cwd, base, ...segments);
  let result = base.startsWith("/") ? base : `${cwd}/${base}`;
  for (const segment of segments) result = result.endsWith("/") ? `${result}${segment}` : `${result}/${segment}`;
  return result;
}
