/**
 * Targeted assertions for the web LLM model catalog: the minimax provider
 * mirrors the daemon catalog, and every provider's default model exists in
 * its models list (the web mirror of the daemon catalog invariant).
 *
 * Also enforces full parity with `meta/llm-provider-catalog.json` (the
 * canonical catalog generated from the daemon's
 * `assistant/src/providers/model-catalog.ts`) so this hand-maintained
 * mirror can never silently drift again.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  MODELS_BY_PROVIDER,
  getModelsForProvider,
  type LlmProviderId,
} from "./llm-model-catalog";

describe("llm-model-catalog", () => {
  test("minimax provider lists MiniMax M3 then MiniMax M2.7", () => {
    expect(getModelsForProvider("minimax").map((model) => model.id)).toEqual([
      "MiniMax-M3",
      "MiniMax-M2.7",
    ]);
  });

  test("every provider's default model exists in its models list", () => {
    for (const [provider, models] of Object.entries(MODELS_BY_PROVIDER)) {
      // openai-compatible is a free-form escape hatch: models are configured
      // per-connection, so it has no catalog entries or default model.
      if (provider === "openai-compatible") continue;
      const defaultModel = DEFAULT_MODEL_BY_PROVIDER[provider as LlmProviderId];
      const modelIds: string[] = models.map((model) => model.id);
      expect(modelIds).toContain(defaultModel);
    }
  });
});

// ---------------------------------------------------------------------------
// Parity with meta/llm-provider-catalog.json
// ---------------------------------------------------------------------------

interface MetaCatalogModel {
  id: string;
  displayName: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  defaultContextWindowTokens?: number;
  longContextPricingThresholdTokens?: number;
  supportsThinking?: boolean;
}

interface MetaCatalogProvider {
  id: string;
  defaultModel: string;
  models: MetaCatalogModel[];
}

interface MetaCatalog {
  version: number;
  providers: MetaCatalogProvider[];
}

// bun:test runs in Bun, so direct filesystem access works here — same
// technique as the daemon's assistant/src/__tests__/llm-catalog-parity.test.ts.
const META_CATALOG_PATH = join(
  import.meta.dir,
  "../../../../meta/llm-provider-catalog.json",
);

/**
 * Project a model down to the fields the web UI uses. The web mirror omits
 * capability fields the UI doesn't render (vision/caching/toolUse/pricing),
 * so only the shared subset is compared. `supportsThinking` is normalized to
 * a boolean because the web mirror omits it when false while the meta JSON
 * carries an explicit `false`.
 */
function comparableModel(model: MetaCatalogModel) {
  return {
    id: model.id,
    displayName: model.displayName,
    contextWindowTokens: model.contextWindowTokens,
    maxOutputTokens: model.maxOutputTokens,
    defaultContextWindowTokens: model.defaultContextWindowTokens,
    longContextPricingThresholdTokens: model.longContextPricingThresholdTokens,
    supportsThinking: model.supportsThinking === true,
  };
}

describe("parity with meta/llm-provider-catalog.json", () => {
  // Intentional asymmetries between the web mirror and the meta catalog:
  // - the web mirror omits daemon-only providers (ollama);
  // - openai-compatible has a per-connection model list, so its (empty)
  //   catalog entry is excluded from model/default comparisons.
  // Field parity therefore iterates web keys, not meta providers; the
  // coverage test below guards the reverse direction.
  const DAEMON_ONLY_PROVIDERS = new Set(["ollama"]);

  const metaCatalog: MetaCatalog = JSON.parse(
    readFileSync(META_CATALOG_PATH, "utf-8"),
  );
  const metaProvidersById = new Map(
    metaCatalog.providers.map((provider) => [provider.id, provider]),
  );
  const webProviderIds = (
    Object.keys(MODELS_BY_PROVIDER) as LlmProviderId[]
  ).filter((id) => id !== "openai-compatible");

  test("every meta provider except daemon-only ones exists in the web mirror", () => {
    // This is the original MiniMax bug: a provider added to the daemon
    // catalog but never mirrored here, leaving an empty Model dropdown.
    const webKeys = new Set<string>(Object.keys(MODELS_BY_PROVIDER));
    for (const provider of metaCatalog.providers) {
      if (DAEMON_ONLY_PROVIDERS.has(provider.id)) continue;
      expect(
        webKeys.has(provider.id),
        `meta provider "${provider.id}" is missing from MODELS_BY_PROVIDER`,
      ).toBe(true);
    }
  });

  for (const providerId of webProviderIds) {
    describe(providerId, () => {
      const metaProvider = metaProvidersById.get(providerId);

      test("exists in the meta catalog", () => {
        expect(
          metaProvider,
          `web provider "${providerId}" has no meta catalog entry`,
        ).toBeDefined();
      });

      test("models match the meta catalog (ids, order, and shared fields)", () => {
        expect(getModelsForProvider(providerId).map(comparableModel)).toEqual(
          (metaProvider?.models ?? []).map(comparableModel),
        );
      });

      test("default model matches the meta catalog", () => {
        expect(metaProvider?.defaultModel).toBe(
          DEFAULT_MODEL_BY_PROVIDER[providerId],
        );
      });
    });
  }
});
