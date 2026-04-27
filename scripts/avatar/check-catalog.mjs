/**
 * Validates that `avatar/character-components.json` is up-to-date with
 * the TypeScript source in `assistant/src/avatar/character-components.ts`.
 *
 * Exits with code 1 if the catalog is stale (i.e. regenerating it would
 * produce a diff). Intended for use in CI to prevent catalog drift.
 *
 * Usage:
 *   bun scripts/avatar/check-catalog.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = resolve(__dirname, "../../assets/character-components.json");
const GENERATE_SCRIPT = resolve(__dirname, "generate-catalog.mjs");

let before;
try {
  before = readFileSync(CATALOG_PATH, "utf-8");
} catch {
  before = null;
}

execSync(`bun ${GENERATE_SCRIPT}`, { stdio: "inherit" });

const after = readFileSync(CATALOG_PATH, "utf-8");

if (before === null) {
  console.error(
    "Error: assets/character-components.json does not exist. Run `bun scripts/avatar/generate-catalog.mjs` to create it.",
  );
  process.exit(1);
}

if (before !== after) {
  writeFileSync(CATALOG_PATH, before, "utf-8");
  console.error(
    "Error: assets/character-components.json is out of date. Run `bun scripts/avatar/generate-catalog.mjs` to regenerate it.",
  );
  process.exit(1);
}

console.log("assets/character-components.json is up to date.");
