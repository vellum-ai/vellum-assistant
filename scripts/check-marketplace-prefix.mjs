#!/usr/bin/env node
/**
 * CI guard: reject marketplace entries whose name uses the reserved
 * `default-` prefix.
 *
 * The `default-` prefix is reserved for first-party default plugins that
 * ship in the assistant source tree. A marketplace entry with that prefix
 * would collide with the built-in plugin's manifest name — the `.disabled`
 * sentinel, the plugin registry, and the tool registry all key on manifest
 * names, so a collision could shadow or clobber the built-in.
 *
 * Exits 0 if all entries are clean, 1 if any entry uses the reserved prefix.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const marketplacePath = join(__dirname, "..", "plugins", "marketplace.json");
const RESERVED_PREFIX = "default-";

const raw = readFileSync(marketplacePath, "utf-8");
const manifest = JSON.parse(raw);

const offenders = manifest.plugins
  .filter((p) => p.name.startsWith(RESERVED_PREFIX))
  .map((p) => p.name);

if (offenders.length > 0) {
  console.error(
    `Error: marketplace entries must not use the reserved "${RESERVED_PREFIX}" prefix:`,
  );
  for (const name of offenders) {
    console.error(`  - ${name}`);
  }
  console.error(
    `\nThe "${RESERVED_PREFIX}" prefix is reserved for first-party default plugins.`,
  );
  process.exit(1);
}

console.log(
  `OK: ${manifest.plugins.length} marketplace entries, none use the reserved "${RESERVED_PREFIX}" prefix.`,
);
