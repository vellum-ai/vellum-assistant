/**
 * Parity guard for the web LLM model catalog: enforces full parity with
 * `meta/llm-provider-catalog.json` (the canonical catalog generated from the
 * daemon's `assistant/src/providers/model-catalog.ts`) so this
 * hand-maintained mirror can never silently drift again.
 *
 * Covers every catalog surface the web UI consumes: per-model fields
 * (ids, order, display names, token limits, thinking flags), per-provider
 * default models, the provider display-name and platform-auth maps, the
 * INFERENCE_PROVIDERS picker list in constants.ts, and the
 * CONNECTION_PROVIDERS picker list in provider-editor-constants.ts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { INFERENCE_PROVIDERS } from "@/domains/settings/ai/constants";
import { CONNECTION_PROVIDERS } from "@/domains/settings/ai/provider-editor-constants";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  MODELS_BY_PROVIDER,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_SUPPORTS_PLATFORM_AUTH,
  getModelsForProvider,
  type LlmProviderId,
} from "./llm-model-catalog";

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
  adaptiveThinkingOnly?: boolean;
}

interface MetaCatalogProvider {
  id: string;
  displayName: string;
  supportsPlatformAuth?: boolean;
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
 * so only the shared subset is compared. `supportsThinking` and
 * `adaptiveThinkingOnly` are normalized to booleans because the web mirror
 * omits them when false while the meta JSON may carry an explicit `false`.
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
    adaptiveThinkingOnly: model.adaptiveThinkingOnly === true,
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

  test("provider display names match the meta catalog", () => {
    // The display-name map deliberately covers every daemon provider
    // (including daemon-only ones like ollama), so this iterates the full
    // meta catalog — the same stale-map drift class as the original bug.
    for (const provider of metaCatalog.providers) {
      expect(
        PROVIDER_DISPLAY_NAMES[provider.id],
        `PROVIDER_DISPLAY_NAMES["${provider.id}"] drifted from meta`,
      ).toBe(provider.displayName);
    }
  });

  test("provider platform-auth support matches the meta catalog", () => {
    // Like the display-name map, this covers every daemon provider so the
    // connection editor can filter auth types for daemon-only providers.
    // Normalized to boolean: missing entries on either side mean `false`.
    for (const provider of metaCatalog.providers) {
      expect(
        PROVIDER_SUPPORTS_PLATFORM_AUTH[provider.id],
        `PROVIDER_SUPPORTS_PLATFORM_AUTH["${provider.id}"] drifted from meta`,
      ).toBe(provider.supportsPlatformAuth === true);
    }
  });

  test("INFERENCE_PROVIDERS covers every web catalog provider", () => {
    // The call-site overrides picker is driven by INFERENCE_PROVIDERS in
    // constants.ts. It must list exactly the catalog providers (minus the
    // free-form openai-compatible escape hatch) or a provider becomes
    // unselectable there. Order is not asserted: the list's order is the
    // picker's display order (a UI choice, with index 0 as the default
    // fallback), not the catalog's.
    expect([...INFERENCE_PROVIDERS].sort()).toEqual([...webProviderIds].sort());
  });

  test("CONNECTION_PROVIDERS covers every meta catalog provider", () => {
    // The connection-creation picker is driven by CONNECTION_PROVIDERS in
    // provider-editor-constants.ts. Unlike INFERENCE_PROVIDERS, it
    // intentionally includes daemon-only providers (ollama) and the
    // free-form openai-compatible escape hatch — any daemon provider can
    // back a connection — so it must list exactly the meta catalog's
    // provider ids or a provider becomes un-creatable as a connection.
    // Order is not asserted: the list's order is the picker's display order.
    const connectionProviderIds: string[] = [...CONNECTION_PROVIDERS];
    expect(connectionProviderIds.sort()).toEqual(
      metaCatalog.providers.map((provider) => provider.id).sort(),
    );
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
