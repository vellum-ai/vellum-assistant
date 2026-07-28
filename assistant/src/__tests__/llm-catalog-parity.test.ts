import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  getCatalogProviderForModel,
  isModelInCatalog,
  PROVIDER_CATALOG,
} from "../providers/model-catalog.js";
import { PLATFORM_PROVIDER_META } from "../providers/platform-proxy/constants.js";
import { resolvePricing, resolvePricingForUsage } from "../util/pricing.js";

/**
 * Parity guard: daemon LLM provider catalog vs client LLM catalog JSON.
 *
 * The daemon maintains its canonical provider catalog in
 * `assistant/src/providers/model-catalog.ts`.
 * The client-facing metadata lives in `meta/llm-provider-catalog.json` and is
 * bundled into native clients at build time (wired up in follow-up PRs).
 *
 * These tests enforce exact structural equality between the two catalogs on
 * every field they share: provider-level metadata, per-model capabilities,
 * and pricing. CI fails when they drift, forcing the developer to update
 * whichever side fell behind.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve repo root (tests run from assistant/) */
function getRepoRoot(): string {
  return join(process.cwd(), "..");
}

const META_JSON_PATH = join(getRepoRoot(), "meta", "llm-provider-catalog.json");

interface ClientCatalogCredentialsGuide {
  description: string;
  url: string;
  linkLabel: string;
}

interface ClientCatalogModel {
  id: string;
  displayName: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  defaultContextWindowTokens?: number;
  longContextPricingThresholdTokens?: number;
  longContextMode?: "native-model" | "provider-request-option" | "unsupported";
  supportsThinking?: boolean;
  adaptiveThinkingOnly?: boolean;
  supportsCaching?: boolean;
  supportsVision?: boolean;
  supportsToolUse?: boolean;
  pricing?: {
    inputPer1mTokens: number;
    outputPer1mTokens: number;
    cacheWritePer1mTokens?: number;
    cacheReadPer1mTokens?: number;
    tiers?: Array<{
      inputTokenThreshold: number;
      inputPer1mTokens: number;
      outputPer1mTokens: number;
      cacheReadPer1mTokens?: number;
      cacheWritePer1mTokens?: number;
    }>;
  };
}

interface ClientCatalogEntry {
  id: string;
  displayName: string;
  subtitle?: string;
  setupMode?: string;
  setupHint?: string;
  envVar?: string;
  apiKeyPlaceholder?: string;
  credentialsGuide?: ClientCatalogCredentialsGuide;
  supportsPlatformAuth?: boolean;
  defaultModel: string;
  models: ClientCatalogModel[];
}

interface ClientCatalog {
  version: number;
  providers: ClientCatalogEntry[];
}

function loadClientCatalog(): ClientCatalog {
  const raw = readFileSync(META_JSON_PATH, "utf-8");
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LLM catalog parity: daemon vs client", () => {
  // -----------------------------------------------------------------------
  // Structural sanity
  // -----------------------------------------------------------------------

  test("client catalog JSON has version 1", () => {
    const json = loadClientCatalog();
    expect(json.version).toBe(1);
  });

  test("client catalog provider count matches daemon", () => {
    const json = loadClientCatalog();
    expect(json.providers.length).toBe(PROVIDER_CATALOG.length);
  });

  // -----------------------------------------------------------------------
  // Provider-level field parity
  // -----------------------------------------------------------------------

  test("each provider's top-level fields match the daemon catalog", () => {
    const json = loadClientCatalog();

    for (let i = 0; i < PROVIDER_CATALOG.length; i++) {
      const daemonEntry = PROVIDER_CATALOG[i]!;
      const clientEntry = json.providers[i]!;

      expect(clientEntry.id).toBe(daemonEntry.id);
      expect(clientEntry.displayName).toBe(daemonEntry.displayName);
      expect(clientEntry.subtitle).toBe(daemonEntry.subtitle);
      expect(clientEntry.setupMode).toBe(daemonEntry.setupMode);
      expect(clientEntry.setupHint).toBe(daemonEntry.setupHint);
      expect(clientEntry.envVar).toBe(daemonEntry.envVar);
      expect(clientEntry.apiKeyPlaceholder).toBe(daemonEntry.apiKeyPlaceholder);
      expect(clientEntry.supportsPlatformAuth).toBe(
        daemonEntry.supportsPlatformAuth,
      );
      expect(clientEntry.credentialsGuide).toEqual(
        daemonEntry.credentialsGuide,
      );
      expect(clientEntry.defaultModel).toBe(daemonEntry.defaultModel);
    }
  });

  test("supportsPlatformAuth mirrors PLATFORM_PROVIDER_META", () => {
    // The catalog field is derived from PLATFORM_PROVIDER_META at build
    // time. This test guards against future hand-edits to model-catalog.ts
    // that would let the two drift. Adding a provider to PLATFORM_PROVIDER_META
    // must auto-propagate; flipping `managed: true` to `false` (or vice
    // versa) must propagate too.
    for (const entry of PROVIDER_CATALOG) {
      const expectedSupportsManagedAuth =
        PLATFORM_PROVIDER_META[entry.id]?.managed === true;
      expect(entry.supportsPlatformAuth).toBe(expectedSupportsManagedAuth);
    }
  });

  test("each provider's model count matches the daemon catalog", () => {
    const json = loadClientCatalog();

    for (let i = 0; i < PROVIDER_CATALOG.length; i++) {
      const daemonEntry = PROVIDER_CATALOG[i]!;
      const clientEntry = json.providers[i]!;
      expect(clientEntry.models.length).toBe(daemonEntry.models.length);
    }
  });

  // -----------------------------------------------------------------------
  // Per-model field parity
  // -----------------------------------------------------------------------

  test("each model's fields match the daemon catalog", () => {
    const json = loadClientCatalog();

    for (let i = 0; i < PROVIDER_CATALOG.length; i++) {
      const daemonEntry = PROVIDER_CATALOG[i]!;
      const clientEntry = json.providers[i]!;

      for (let j = 0; j < daemonEntry.models.length; j++) {
        const daemonModel = daemonEntry.models[j]!;
        const clientModel = clientEntry.models[j]!;

        expect(clientModel.id).toBe(daemonModel.id);
        expect(clientModel.displayName).toBe(daemonModel.displayName);
        expect(clientModel.contextWindowTokens).toBe(
          daemonModel.contextWindowTokens,
        );
        expect(clientModel.maxOutputTokens).toBe(daemonModel.maxOutputTokens);
        expect(clientModel.defaultContextWindowTokens).toBe(
          daemonModel.defaultContextWindowTokens,
        );
        expect(clientModel.longContextPricingThresholdTokens).toBe(
          daemonModel.longContextPricingThresholdTokens,
        );
        expect(clientModel.longContextMode).toBe(daemonModel.longContextMode);
        expect(clientModel.supportsThinking).toBe(daemonModel.supportsThinking);
        expect(clientModel.adaptiveThinkingOnly).toBe(
          daemonModel.adaptiveThinkingOnly,
        );
        expect(clientModel.supportsCaching).toBe(daemonModel.supportsCaching);
        expect(clientModel.supportsVision).toBe(daemonModel.supportsVision);
        expect(clientModel.supportsToolUse).toBe(daemonModel.supportsToolUse);
        expect(clientModel.pricing).toEqual(daemonModel.pricing);
      }
    }
  });

  // -----------------------------------------------------------------------
  // Internal consistency
  // -----------------------------------------------------------------------

  test("every provider's defaultModel exists in its models list", () => {
    for (const entry of PROVIDER_CATALOG) {
      // Providers with an empty models list (e.g. openai-compatible) use
      // per-connection model identifiers instead of a static catalog.
      if (entry.models.length === 0) continue;
      const found = entry.models.some((m) => m.id === entry.defaultModel);
      expect(
        found,
        `defaultModel "${entry.defaultModel}" not in models for provider "${entry.id}"`,
      ).toBe(true);
    }
  });

  test("cache pricing rates are positive when defined", () => {
    for (const entry of PROVIDER_CATALOG) {
      for (const model of entry.models) {
        if (!model.pricing) continue;
        if (model.pricing.cacheReadPer1mTokens !== undefined) {
          expect(
            model.pricing.cacheReadPer1mTokens,
            `${entry.id}/${model.id} cacheReadPer1mTokens must be positive`,
          ).toBeGreaterThan(0);
        }
        if (model.pricing.cacheWritePer1mTokens !== undefined) {
          expect(
            model.pricing.cacheWritePer1mTokens,
            `${entry.id}/${model.id} cacheWritePer1mTokens must be positive`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  test("every model default context is capped by its context window", () => {
    const json = loadClientCatalog();

    for (const entry of PROVIDER_CATALOG) {
      for (const model of entry.models) {
        expect(model.defaultContextWindowTokens).toBeGreaterThan(0);
        if (model.contextWindowTokens === undefined) continue;
        expect(
          model.defaultContextWindowTokens,
          `${entry.id}/${model.id} default context exceeds context window`,
        ).toBeLessThanOrEqual(model.contextWindowTokens);
      }
    }

    for (const entry of json.providers) {
      for (const model of entry.models) {
        expect(model.defaultContextWindowTokens).toBeGreaterThan(0);
        if (model.contextWindowTokens === undefined) continue;
        expect(
          model.defaultContextWindowTokens,
          `${entry.id}/${model.id} JSON default context exceeds context window`,
        ).toBeLessThanOrEqual(model.contextWindowTokens);
      }
    }
  });

  test("sub-200k model defaults are clamped to model context caps", () => {
    const ollama = PROVIDER_CATALOG.find((entry) => entry.id === "ollama");
    expect(
      ollama?.models.find((model) => model.id === "llama3.2"),
    ).toMatchObject({
      contextWindowTokens: 128000,
      defaultContextWindowTokens: 128000,
    });
    expect(
      ollama?.models.find((model) => model.id === "mistral"),
    ).toMatchObject({
      contextWindowTokens: 32768,
      defaultContextWindowTokens: 32768,
    });
  });

  test("OpenAI catalog includes long-context pricing metadata", () => {
    const openai = PROVIDER_CATALOG.find((entry) => entry.id === "openai");
    expect(
      openai?.models.find((model) => model.id === "gpt-5.5-pro"),
    ).toMatchObject({
      displayName: "GPT-5.5 Pro",
      contextWindowTokens: 1050000,
      defaultContextWindowTokens: 200000,
      maxOutputTokens: 128000,
      longContextPricingThresholdTokens: 272000,
      longContextMode: "native-model",
    });
    expect(
      openai?.models.find((model) => model.id === "gpt-5.4"),
    ).toMatchObject({
      displayName: "GPT-5.4",
      contextWindowTokens: 1050000,
      defaultContextWindowTokens: 200000,
      maxOutputTokens: 128000,
      longContextPricingThresholdTokens: 272000,
      longContextMode: "native-model",
    });
  });

  test("Fireworks catalog includes GLM 5.2", () => {
    expect(
      isModelInCatalog("fireworks", "accounts/fireworks/models/glm-5p2"),
    ).toBe(true);

    const fireworks = PROVIDER_CATALOG.find(
      (entry) => entry.id === "fireworks",
    );
    expect(
      fireworks?.models.find(
        (model) => model.id === "accounts/fireworks/models/glm-5p2",
      ),
    ).toMatchObject({
      displayName: "GLM 5.2",
      contextWindowTokens: 1040000,
      maxOutputTokens: 131072,
      supportsToolUse: true,
      supportsVision: false,
      pricing: {
        inputPer1mTokens: 1.4,
        outputPer1mTokens: 4.4,
        cacheReadPer1mTokens: 0.26,
      },
    });
  });

  test("MiniMax catalog includes MiniMax M3", () => {
    const minimax = PROVIDER_CATALOG.find((entry) => entry.id === "minimax");
    expect(
      minimax?.models.find((model) => model.id === "MiniMax-M3"),
    ).toMatchObject({
      displayName: "MiniMax M3",
      contextWindowTokens: 1000000,
      defaultContextWindowTokens: 200000,
      maxOutputTokens: 512000,
      longContextMode: "native-model",
      supportsThinking: true,
      supportsVision: true,
      supportsToolUse: true,
    });
  });

  // -----------------------------------------------------------------------
  // pricing.ts ↔ model-catalog.ts parity
  //
  // `assistant/src/util/pricing.ts` reads pricing from `PROVIDER_CATALOG`
  // (catalog-first) with a legacy fallback table for models we still bill
  // for but no longer advertise. These tests probe `resolvePricing` /
  // `resolvePricingForUsage` for every priced catalog model so any drift
  // between the catalog row and the resolver's output (including cache
  // discounts and long-context tier rates) fails CI.
  // -----------------------------------------------------------------------

  test("each priced catalog model has matching base rates in pricing.ts", () => {
    // 100k tokens stays below every long-context tier threshold in the
    // catalog (smallest threshold is 200k), so resolvePricing returns the
    // base rate uncontaminated by tier selection.
    const PROBE_TOKENS = 100_000;
    const TOKENS_PER_MILLION = 1_000_000;

    for (const provider of PROVIDER_CATALOG) {
      for (const model of provider.models) {
        if (!model.pricing) continue;

        const inputResult = resolvePricing(
          provider.id,
          model.id,
          PROBE_TOKENS,
          0,
        );
        expect(
          inputResult.pricingStatus,
          `${provider.id}/${model.id} unpriced in pricing.ts`,
        ).toBe("priced");
        const inputRate =
          (inputResult.estimatedCostUsd ?? 0) *
          (TOKENS_PER_MILLION / PROBE_TOKENS);
        expect(
          inputRate,
          `${provider.id}/${model.id} input rate drift`,
        ).toBeCloseTo(model.pricing.inputPer1mTokens, 6);

        const outputResult = resolvePricing(
          provider.id,
          model.id,
          0,
          PROBE_TOKENS,
        );
        const outputRate =
          (outputResult.estimatedCostUsd ?? 0) *
          (TOKENS_PER_MILLION / PROBE_TOKENS);
        expect(
          outputRate,
          `${provider.id}/${model.id} output rate drift`,
        ).toBeCloseTo(model.pricing.outputPer1mTokens, 6);
      }
    }
  });

  test("each priced catalog model has matching cache-read rate in pricing.ts", () => {
    const PROBE_TOKENS = 100_000;
    const TOKENS_PER_MILLION = 1_000_000;

    for (const provider of PROVIDER_CATALOG) {
      for (const model of provider.models) {
        const cacheReadCatalogRate = model.pricing?.cacheReadPer1mTokens;
        if (cacheReadCatalogRate === undefined) continue;

        const result = resolvePricingForUsage(provider.id, model.id, {
          directInputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: PROBE_TOKENS,
          anthropicCacheCreation: null,
        });
        expect(
          result.pricingStatus,
          `${provider.id}/${model.id} unpriced in pricing.ts`,
        ).toBe("priced");
        const cacheReadResolvedRate =
          (result.estimatedCostUsd ?? 0) * (TOKENS_PER_MILLION / PROBE_TOKENS);
        expect(
          cacheReadResolvedRate,
          `${provider.id}/${model.id} cache-read rate drift`,
        ).toBeCloseTo(cacheReadCatalogRate, 6);
      }
    }
  });

  test("each priced catalog tier resolves at its tier rate", () => {
    const TOKENS_PER_MILLION = 1_000_000;

    for (const provider of PROVIDER_CATALOG) {
      for (const model of provider.models) {
        const tiers = model.pricing?.tiers;
        if (!tiers || tiers.length === 0) continue;

        for (const tier of tiers) {
          const probeTokens = tier.inputTokenThreshold + 1_000;
          const result = resolvePricingForUsage(provider.id, model.id, {
            directInputTokens: probeTokens,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            anthropicCacheCreation: null,
          });
          expect(
            result.pricingStatus,
            `${provider.id}/${model.id} unpriced at tier ${tier.inputTokenThreshold}`,
          ).toBe("priced");
          const resolvedRate =
            (result.estimatedCostUsd ?? 0) * (TOKENS_PER_MILLION / probeTokens);
          expect(
            resolvedRate,
            `${provider.id}/${model.id} input rate drift at tier ${tier.inputTokenThreshold}`,
          ).toBeCloseTo(tier.inputPer1mTokens, 6);
        }
      }
    }
  });

  test("getCatalogProviderForModel breaks shared-ID ties by catalog order", () => {
    // OpenRouter and the Vercel AI Gateway both list this ID; OpenRouter comes
    // first in PROVIDER_CATALOG, so model→provider inference must keep
    // returning "openrouter" for configs that predate the gateway.
    expect(getCatalogProviderForModel("anthropic/claude-sonnet-4.6")).toBe(
      "openrouter",
    );
  });

  test("getCatalogProviderForModel resolves gateway-unique IDs", () => {
    expect(getCatalogProviderForModel("xai/grok-4.3")).toBe(
      "vercel-ai-gateway",
    );
  });

  test("getCatalogProviderForModel returns undefined for unknown IDs", () => {
    expect(getCatalogProviderForModel("unknown/model")).toBeUndefined();
  });

  test("Gemini 2.5 Pro catalog context matches provider limits", () => {
    const gemini = PROVIDER_CATALOG.find((entry) => entry.id === "gemini");
    expect(
      gemini?.models.find((model) => model.id === "gemini-2.5-pro"),
    ).toMatchObject({
      displayName: "Gemini 2.5 Pro",
      contextWindowTokens: 1048576,
      defaultContextWindowTokens: 200000,
      maxOutputTokens: 65536,
      longContextPricingThresholdTokens: 200000,
      longContextMode: "native-model",
    });
  });
});
