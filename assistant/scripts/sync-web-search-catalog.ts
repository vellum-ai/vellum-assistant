#!/usr/bin/env bun
/**
 * Generate `meta/web-search-provider-catalog.json` from the canonical
 * `SEARCH_PROVIDER_CATALOG` in
 * `assistant/src/providers/search-provider-catalog.ts`.
 *
 * Companion to `sync-llm-catalog.ts`. The meta JSON is the cross-package
 * artifact consumed by:
 *
 *   - `cli/src/__tests__/search-provider-env-var-parity.test.ts`
 *     (drift guard for the CLI's hardcoded env-var mirror).
 *   - Downstream `vellum-assistant-platform/web/src/lib/generated/
 *     web-search-provider-catalog.json` (manually sync'd today; scheduled
 *     sync workflow is a planned follow-up).
 *
 * Usage:
 *   cd assistant && bun run scripts/sync-web-search-catalog.ts
 *   cd assistant && bun run sync:web-search-catalog              # via npm script
 *   cd assistant && bun run sync:web-search-catalog -- --check   # CI: fail if stale
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  SEARCH_PROVIDER_CATALOG,
  type SearchProviderCatalogEntry,
} from "../src/providers/search-provider-catalog.js";

const ROOT = resolve(import.meta.dir, "../..");
const OUTPUT_PATH = join(ROOT, "meta/web-search-provider-catalog.json");

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
    let current = "";
    try {
      current = await readFile(OUTPUT_PATH, "utf8");
    } catch {
      // File doesn't exist yet — treat as stale.
    }
    if (current !== next) {
      console.error(
        `\n${OUTPUT_PATH} is out of sync with SEARCH_PROVIDER_CATALOG.\n` +
          `Run: cd assistant && bun run sync:web-search-catalog\n`,
      );
      process.exit(1);
    }
    return;
  }

  await writeFile(OUTPUT_PATH, next, "utf8");
  console.log(`Wrote ${OUTPUT_PATH}`);
}

await main();
