#!/usr/bin/env bun
/**
 * Generate the client-facing web-search-provider catalog JSON from the
 * canonical `SEARCH_PROVIDER_CATALOG` in
 * `assistant/src/providers/search-provider-catalog.ts`.
 *
 * Two byte-identical copies are written:
 *   - `meta/web-search-provider-catalog.json` — primary checked-in artifact,
 *      consumed by:
 *        - `cli/src/__tests__/search-provider-env-var-parity.test.ts`
 *          (drift guard for the CLI's hardcoded env-var mirror).
 *        - Downstream `vellum-assistant-platform/web/src/lib/generated/
 *          web-search-provider-catalog.json` (manually sync'd today; the
 *          scheduled sync workflow is a planned follow-up).
 *   - `clients/shared/Resources/web-search-provider-catalog.json` — SwiftPM
 *      resource bundled into `VellumAssistantShared`. SwiftPM cannot reach
 *      files outside a target's source directory, so this mirror is
 *      necessary; both files are produced by the same generator and
 *      asserted equal by the parity test, making drift impossible.
 *
 * Companion to `sync-llm-catalog.ts`; same dual-write pattern.
 *
 * Usage:
 *   cd assistant && bun run scripts/sync-web-search-catalog.ts
 *   cd assistant && bun run sync:web-search-catalog              # via npm script
 *   cd assistant && bun run sync:web-search-catalog -- --check   # CI: fail if stale
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import {
  SEARCH_PROVIDER_CATALOG,
  type SearchProviderCatalogEntry,
} from "../src/providers/search-provider-catalog.js";

const ROOT = resolve(import.meta.dir, "../..");
const OUTPUT_PATHS = [
  join(ROOT, "meta/web-search-provider-catalog.json"),
  join(ROOT, "clients/shared/Resources/web-search-provider-catalog.json"),
] as const;

/**
 * Bumped when the *shape* of the client catalog JSON changes in a way
 * downstream consumers must opt into. Adding optional fields that older
 * consumers can ignore does NOT require a bump.
 */
const CLIENT_CATALOG_VERSION = 1;

function projectProvider(
  entry: SearchProviderCatalogEntry,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    id: entry.id,
    displayName: entry.displayName,
  };
  if (entry.displayNameLong !== undefined) {
    projected.displayNameLong = entry.displayNameLong;
  }
  projected.kind = entry.kind;
  if (entry.apiKeyPrefix !== undefined) {
    projected.apiKeyPrefix = entry.apiKeyPrefix;
  }
  if (entry.envVar !== undefined) {
    projected.envVar = entry.envVar;
  }
  if (entry.secretKey !== undefined) {
    projected.secretKey = entry.secretKey;
  }
  if (entry.fallbackOrder !== undefined) {
    projected.fallbackOrder = entry.fallbackOrder;
  }
  if (entry.privacyPolicyUrl !== undefined) {
    projected.privacyPolicyUrl = entry.privacyPolicyUrl;
  }
  return projected;
}

function generate(): string {
  return (
    JSON.stringify(
      {
        version: CLIENT_CATALOG_VERSION,
        providers: SEARCH_PROVIDER_CATALOG.map(projectProvider),
      },
      null,
      2,
    ) + "\n"
  );
}

async function main(): Promise<void> {
  const checkMode = process.argv.includes("--check");
  const next = generate();

  if (checkMode) {
    let anyStale = false;
    for (const path of OUTPUT_PATHS) {
      const rel = relative(ROOT, path);
      let existing = "";
      try {
        existing = await readFile(path, "utf-8");
      } catch {
        console.error(
          `${rel} does not exist. Run: bun run sync:web-search-catalog`,
        );
        anyStale = true;
        continue;
      }
      if (existing !== next) {
        console.error(
          `${rel} is stale. Run: bun run sync:web-search-catalog`,
        );
        anyStale = true;
        continue;
      }
      console.log(`${rel} is up to date.`);
    }
    if (anyStale) process.exit(1);
    return;
  }

  for (const path of OUTPUT_PATHS) {
    await writeFile(path, next, "utf-8");
    console.log(`Wrote ${relative(ROOT, path)}`);
  }
}

await main();
