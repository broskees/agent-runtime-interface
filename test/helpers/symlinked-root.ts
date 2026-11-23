// A directory layout where a path with `..` after a symbolic link means one
// thing to the operating system and another to lexical normalization:
//
//   <root>/releases/2026-11/      (a directory)
//   <root>/current -> releases/2026-11
//
// The OS reads `<root>/current/../x` as `<root>/releases/x`: it follows
// `current` first, then goes up. `path.resolve` and `path.join` collapse the
// string to `<root>/x` instead. Tests use this to show that `ari/node` passes
// host-given paths to the OS as given.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface SymlinkedRoot {
  /** The real, canonical root directory. */
  readonly root: string;
  /** `<root>/current/../<name>`, a path the OS reads as `<root>/releases/<name>`. */
  throughSymlink(name: string): string;
  /** `<root>/releases/<name>`, where the OS puts what `throughSymlink(name)` names. */
  real(name: string): string;
  /** `<root>/<name>`, where lexical normalization would wrongly put it. */
  collapsed(name: string): string;
}

export async function createSymlinkedRoot(prefix: string): Promise<SymlinkedRoot> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  await fs.mkdir(`${root}/releases/2026-11`, { recursive: true });
  await fs.symlink("releases/2026-11", `${root}/current`);
  return {
    root,
    throughSymlink: (name) => `${root}/current/../${name}`,
    real: (name) => `${root}/releases/${name}`,
    collapsed: (name) => `${root}/${name}`,
  };
}

export async function exists(target: string): Promise<boolean> {
  return fs.stat(target).then(
    () => true,
    () => false,
  );
}
