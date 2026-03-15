#!/usr/bin/env bun
/**
 * Copies the canonical feature-flag-registry.json into assistant/ and gateway/
 * so bundled/compiled builds can resolve it without the repo-root meta/ tree.
 *
 * Usage:
 *   bun run meta/feature-flags/sync-bundled-copies.ts
 */
import { copyFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir);
const CANONICAL = join(ROOT, "feature-flag-registry.json");

const TARGETS = [
  join(ROOT, "..", "..", "assistant", "src", "config", "feature-flag-registry.json"),
  join(ROOT, "..", "..", "gateway", "src", "feature-flag-registry.json"),
];

for (const target of TARGETS) {
  copyFileSync(CANONICAL, target);
}
console.log(`✓ Synced feature-flag-registry.json to ${TARGETS.length} targets`);
