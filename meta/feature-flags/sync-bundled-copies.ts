#!/usr/bin/env bun
/**
 * Copies canonical repo files into locations where bundled/compiled builds can
 * resolve them without the repo-root meta/ or plugins/ trees:
 *   - feature-flag-registry.json → assistant/, gateway/, web/
 *   - plugins/marketplace.json    → the assistant plugin catalog (offline reader)
 *
 * Usage:
 *   bun run meta/feature-flags/sync-bundled-copies.ts
 */
import { copyFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir);

const PAIRS: { canonical: string; targets: string[] }[] = [
  {
    canonical: join(ROOT, "feature-flag-registry.json"),
    targets: [
      join(ROOT, "..", "..", "assistant", "src", "config", "feature-flag-registry.json"),
      join(ROOT, "..", "..", "gateway", "src", "feature-flag-registry.json"),
      join(ROOT, "..", "..", "clients", "web", "src", "lib", "feature-flags", "feature-flag-registry.json"),
    ],
  },
  {
    canonical: join(ROOT, "..", "..", "plugins", "marketplace.json"),
    targets: [
      join(ROOT, "..", "..", "assistant", "src", "cli", "lib", "bundled-marketplace.json"),
    ],
  },
];

let count = 0;
for (const { canonical, targets } of PAIRS) {
  for (const target of targets) {
    copyFileSync(canonical, target);
    count++;
  }
}
console.log(
  `✓ Synced feature-flag-registry.json and plugins/marketplace.json to ${count} targets`,
);
