import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { LLM_PROVIDER_ENV_VAR_NAMES } from "../shared/provider-env-vars.js";

/**
 * Drift guard for the CLI-side LLM provider env-var mirror.
 *
 * `cli/src/shared/provider-env-vars.ts` hardcodes the LLM env-var names so the
 * CLI doesn't need to import the assistant's `PROVIDER_CATALOG` (no CLI →
 * assistant cross-package imports exist). This test pulls the catalog JSON at
 * `meta/llm-provider-catalog.json` — which is kept in sync with
 * `PROVIDER_CATALOG` by `assistant/src/__tests__/llm-catalog-parity.test.ts` —
 * and asserts the CLI's mirror matches the catalog's `envVar` entries.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

interface LlmCatalogEntry {
  id: string;
  envVar?: string;
}

interface LlmCatalog {
  version: number;
  providers: LlmCatalogEntry[];
}

function loadLlmCatalog(): LlmCatalog {
  const path = join(REPO_ROOT, "meta", "llm-provider-catalog.json");
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("CLI provider env-var parity", () => {
  test("LLM_PROVIDER_ENV_VAR_NAMES matches meta/llm-provider-catalog.json entries with envVar", () => {
    const catalog = loadLlmCatalog();
    const expected: Record<string, string> = {};
    for (const provider of catalog.providers) {
      if (provider.envVar) expected[provider.id] = provider.envVar;
    }
    expect(LLM_PROVIDER_ENV_VAR_NAMES).toEqual(expected);
  });
});
