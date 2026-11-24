// Writes the generated part of each client from json-schema/ and
// spec/v1/methods.json:
//
//   clients/rust/src/generated.rs
//   clients/python/src/ari_client/_generated.py
//   clients/go/generated.go
//
//   node clients/codegen/index.ts           write them
//   node clients/codegen/index.ts --check   exit 1 when a committed file differs (the gate runs this)

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { generateGo } from "./go.ts";
import { loadWireModel, ModelError } from "./model.ts";
import { generatePython } from "./python.ts";
import { generateRust } from "./rust.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Every generated client file, keyed by path relative to `root`. */
export function generateClients(root: string): Map<string, string> {
  const model = loadWireModel(root);
  return new Map([
    ["clients/rust/src/generated.rs", generateRust(model)],
    ["clients/python/src/ari_client/_generated.py", generatePython(model)],
    ["clients/go/generated.go", generateGo(model)],
  ]);
}

/** The generated files that differ from what the schema gives, or are missing. */
export function findClientDrift(root: string): string[] {
  const drift: string[] = [];
  for (const [relative, content] of generateClients(root)) {
    const full = path.join(root, relative);
    if (!fs.existsSync(full)) drift.push(`${relative} is missing`);
    else if (fs.readFileSync(full, "utf8") !== content) drift.push(`${relative} differs from json-schema/ and spec/v1/methods.json`);
  }
  return drift;
}

function main(argv: readonly string[]): number {
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex === -1 ? ROOT : path.resolve(argv[rootIndex + 1] ?? ".");
  try {
    if (argv.includes("--check")) {
      const drift = findClientDrift(root);
      if (drift.length > 0) {
        process.stderr.write(`codegen:clients:check failed. Run \`pnpm run codegen:clients\`.\n${drift.map((line) => `  ${line}`).join("\n")}\n`);
        return 1;
      }
      process.stdout.write("codegen:clients:check passed: the Rust, Python and Go wire types match json-schema/ and spec/v1/methods.json.\n");
      return 0;
    }
    for (const [relative, content] of generateClients(root)) {
      const full = path.join(root, relative);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      if (!fs.existsSync(full) || fs.readFileSync(full, "utf8") !== content) fs.writeFileSync(full, content);
    }
    process.stdout.write("codegen:clients wrote the Rust, Python and Go wire types.\n");
    return 0;
  } catch (error) {
    if (error instanceof ModelError) {
      process.stderr.write(`codegen:clients failed: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
