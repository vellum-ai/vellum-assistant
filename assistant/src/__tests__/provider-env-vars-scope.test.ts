import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * Scope guard for `meta/provider-env-vars.json`.
 *
 * Since the LLM-provider env-var map moved into `PROVIDER_CATALOG` (see
 * `assistant/src/providers/model-catalog.ts` and the `getLlmProviderEnvVar`
 * helper in `assistant/src/providers/provider-env-vars.ts`), this JSON file
 * must contain only **search-provider** env vars. Any LLM entries sneaking
 * back in here would reintroduce the duplicated source of truth this
 * refactor removed.
 */

interface ProviderEnvVarsRegistry {
  version: number;
  providers: Record<string, string>;
}

function loadRegistry(): ProviderEnvVarsRegistry {
  const repoRoot = join(process.cwd(), "..");
  const path = join(repoRoot, "meta", "provider-env-vars.json");
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("provider-env-vars.json scope", () => {
  test("schema is version 2", () => {
    const json = loadRegistry();
    expect(json.version).toBe(2);
  });

  test("providers map contains exactly brave and perplexity", () => {
    const json = loadRegistry();
    const keys = Object.keys(json.providers).sort();
    expect(keys).toEqual(["brave", "perplexity"]);
  });

  test("no LLM-provider entries leak into the search-provider registry", () => {
    const json = loadRegistry();
    const llmProviderIds = [
      "anthropic",
      "openai",
      "gemini",
      "fireworks",
      "openrouter",
    ];
    for (const id of llmProviderIds) {
      expect(json.providers[id]).toBeUndefined();
    }
  });
});
