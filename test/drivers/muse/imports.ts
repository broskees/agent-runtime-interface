// The module graph of a source file, for checks that an entry loads nothing
// outside the package.

import * as fs from "node:fs";
import * as path from "node:path";
import { findImports } from "../../../scripts/check-rules.ts";

/** Every module specifier reachable from `entry` through static and dynamic imports, following relative ones. */
export function reachableImports(entry: string): { files: string[]; external: string[] } {
  const seen = new Set<string>();
  const external = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const site of findImports(file, fs.readFileSync(file, "utf8"))) {
      if (site.typeOnly) continue;
      const specifier = site.specifier ?? `<computed: ${site.expression}>`;
      if (specifier.startsWith(".")) visit(path.resolve(path.dirname(file), specifier));
      else external.add(specifier);
    }
  };
  visit(entry);
  return { files: [...seen].sort(), external: [...external].sort() };
}
