import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { inferProviderFromModel } from "../lib/provider-secrets.js";

/**
 * Drift guard for the CLI's model → provider inference heuristic.
 *
 * `inferProviderFromModel` mirrors the assistant resolver's
 * `getCatalogProviderForModel` semantics without importing from
 * `assistant/src/`: a model ID listed by multiple catalog providers resolves
 * to the FIRST provider in catalog order (e.g. `anthropic/*` IDs shared by
 * OpenRouter and the Vercel AI Gateway resolve to openrouter), while an ID
 * unique to one provider resolves to that provider (e.g. `openai/gpt-5.5` and
 * `xai/grok-4.3` to vercel-ai-gateway). This test recomputes that expectation
 * from `meta/llm-provider-catalog.json` for every vendor-prefixed
 * (slash-containing) model ID and fails if a catalog change breaks the
 * heuristic.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

interface LlmCatalog {
  providers: Array<{ id: string; models: Array<{ id: string }> }>;
}

function loadLlmCatalog(): LlmCatalog {
  const path = join(REPO_ROOT, "meta", "llm-provider-catalog.json");
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("CLI provider inference parity", () => {
  test("inferProviderFromModel matches first-catalog-provider resolution for every vendor-prefixed model ID", () => {
    const catalog = loadLlmCatalog();
    const expected: Record<string, string> = {};
    for (const provider of catalog.providers) {
      for (const model of provider.models) {
        if (!model.id.includes("/")) {
          continue;
        }
        expected[model.id] ??= provider.id;
      }
    }

    // Sanity: the catalog still exercises both the unique-ID and shared-ID
    // paths this guard exists for.
    expect(Object.values(expected)).toContain("vercel-ai-gateway");
    expect(Object.values(expected)).toContain("openrouter");

    const actual: Record<string, string | undefined> = {};
    for (const modelId of Object.keys(expected)) {
      actual[modelId] = inferProviderFromModel(modelId);
    }
    expect(actual).toEqual(expected);
  });
});
