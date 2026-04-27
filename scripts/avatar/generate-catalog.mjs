/**
 * Generates `avatar/character-components.json` from the TypeScript source
 * in `assistant/src/avatar/character-components.ts`.
 *
 * The JSON catalog is fetched by the platform at runtime so the web
 * client (and other clients) can render character avatars without
 * depending on the assistant daemon being up.
 *
 * Usage:
 *   bun scripts/avatar/generate-catalog.mjs
 */

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Import the TS source directly — bun/node with ts support handles this.
const { getCharacterComponents } = await import(
  resolve(__dirname, "../../assistant/src/avatar/character-components.ts")
);

const CATALOG_PATH = resolve(__dirname, "../../assets/character-components.json");

const catalog = getCharacterComponents();
const json = JSON.stringify(catalog, null, 2) + "\n";

writeFileSync(CATALOG_PATH, json, "utf-8");
console.log(`Wrote ${CATALOG_PATH} (${json.length} bytes)`);
