import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { SEARCH_PROVIDER_ENV_VAR_NAMES } from "../shared/provider-env-vars.js";

/**
 * Drift guard for the CLI-side search provider env-var mirror.
 *
 * `cli/src/shared/provider-env-vars.ts` hardcodes the search env-var names so
 * the CLI doesn't need to import the assistant's
 * `SEARCH_PROVIDER_CATALOG` (no CLI → assistant cross-package imports exist).
 * This test pulls the catalog JSON at `meta/web-search-provider-catalog.json`
 * — which is kept in sync with `SEARCH_PROVIDER_CATALOG` by
 * `assistant/src/__tests__/web-search-catalog-parity.test.ts` — and asserts
 * the CLI's mirror matches the catalog's `envVar` entries.
 *
 * Mirrors `llm-provider-env-var-parity.test.ts`.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

interface SearchCatalogEntry {
  id: string;
  kind: "managed" | "byok";
  envVar?: string;
}

interface SearchCatalog {
  version: number;
  providers: SearchCatalogEntry[];
}

function loadSearchCatalog(): SearchCatalog {
  const path = join(REPO_ROOT, "meta", "web-search-provider-catalog.json");
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("CLI search provider env-var parity", () => {
  test("SEARCH_PROVIDER_ENV_VAR_NAMES matches meta/web-search-provider-catalog.json entries with envVar", () => {
    const catalog = loadSearchCatalog();
    const expected: Record<string, string> = {};
    for (const provider of catalog.providers) {
      if (provider.envVar) expected[provider.id] = provider.envVar;
    }
    expect(SEARCH_PROVIDER_ENV_VAR_NAMES).toEqual(expected);
  });
});
