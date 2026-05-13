/**
 * Validates that `skills/catalog.json` is up-to-date with the SKILL.md
 * frontmatter in each skill directory.
 *
 * Exits with code 1 if the catalog is stale (i.e. regenerating it would
 * produce a diff). Intended for use in CI to prevent catalog drift.
 *
 * Usage:
 *   node scripts/skills/check-catalog.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = resolve(__dirname, "../../skills/catalog.json");
const GENERATE_SCRIPT = resolve(__dirname, "generate-catalog.mjs");

// Read the current catalog contents (if any)
let before;
try {
  before = readFileSync(CATALOG_PATH, "utf-8");
} catch {
  before = null;
}

// Regenerate the catalog
execSync(`node ${GENERATE_SCRIPT}`, { stdio: "inherit" });

// Read the newly generated catalog
const after = readFileSync(CATALOG_PATH, "utf-8");

if (before === null) {
  // Restore absence - the file didn't exist before
  console.error(
    "Error: skills/catalog.json does not exist. Run `node scripts/skills/generate-catalog.mjs` to create it.",
  );
  process.exit(1);
}

if (before !== after) {
  // Print the first few differing lines for easier debugging.
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const max = Math.max(beforeLines.length, afterLines.length);
  let printed = 0;
  for (let i = 0; i < max && printed < 12; i++) {
    if (beforeLines[i] !== afterLines[i]) {
      console.error(`@@ line ${i + 1}`);
      console.error(`- ${beforeLines[i] ?? ""}`);
      console.error(`+ ${afterLines[i] ?? ""}`);
      printed++;
    }
  }
  // Restore the original so the working tree stays clean
  writeFileSync(CATALOG_PATH, before, "utf-8");
  console.error(
    "Error: skills/catalog.json is out of date. Run `node scripts/skills/generate-catalog.mjs` to regenerate it.",
  );
  process.exit(1);
}

console.log("skills/catalog.json is up to date.");
