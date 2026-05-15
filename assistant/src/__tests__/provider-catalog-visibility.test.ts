import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { _setOverridesForTesting } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";
import { PROVIDER_CATALOG } from "../providers/model-catalog.js";
import { getVisibleProviderCatalog } from "../providers/provider-catalog-visibility.js";

beforeEach(() => {
  _setOverridesForTesting({});
});

afterEach(() => {
  _setOverridesForTesting({});
});

/** Minimal AssistantConfig stub for feature-flag resolution. */
function makeConfig(): AssistantConfig {
  return {} as AssistantConfig;
}

describe("getVisibleProviderCatalog", () => {
  test("returns the full catalog when all feature flags are enabled", () => {
    const allFlags: Record<string, boolean> = {};
    for (const entry of PROVIDER_CATALOG) {
      if (entry.featureFlag) allFlags[entry.featureFlag] = true;
      for (const model of entry.models) {
        if (model.featureFlag) allFlags[model.featureFlag] = true;
      }
    }
    _setOverridesForTesting(allFlags);

    const visible = getVisibleProviderCatalog(makeConfig());
    expect(visible.length).toBe(PROVIDER_CATALOG.length);
    expect(visible.map((p) => p.id)).toEqual(PROVIDER_CATALOG.map((p) => p.id));
  });

  test("hides a provider whose featureFlag is disabled", () => {
    const allFlags: Record<string, boolean> = {};
    for (const entry of PROVIDER_CATALOG) {
      if (entry.featureFlag) allFlags[entry.featureFlag] = true;
      for (const model of entry.models) {
        if (model.featureFlag) allFlags[model.featureFlag] = true;
      }
    }
    _setOverridesForTesting({ ...allFlags, "test-provider-flag": false });

    const original = [...PROVIDER_CATALOG];
    PROVIDER_CATALOG.push({
      id: "__test_flagged_provider__",
      displayName: "Test Flagged Provider",
      models: [
        {
          id: "test-model",
          displayName: "Test Model",
        },
      ],
      defaultModel: "test-model",
      featureFlag: "test-provider-flag",
    });

    try {
      const visible = getVisibleProviderCatalog(makeConfig());
      expect(
        visible.find((p) => p.id === "__test_flagged_provider__"),
      ).toBeUndefined();
      expect(visible.length).toBe(original.length);
    } finally {
      PROVIDER_CATALOG.length = 0;
      PROVIDER_CATALOG.push(...original);
    }
  });

  test("hides a model whose featureFlag is disabled but keeps the provider", () => {
    _setOverridesForTesting({ "test-model-flag": false });

    const original = [...PROVIDER_CATALOG];
    PROVIDER_CATALOG.push({
      id: "__test_provider_with_flagged_model__",
      displayName: "Test Provider",
      models: [
        {
          id: "visible-model",
          displayName: "Visible Model",
        },
        {
          id: "flagged-model",
          displayName: "Flagged Model",
          featureFlag: "test-model-flag",
        },
      ],
      defaultModel: "visible-model",
    });

    try {
      const visible = getVisibleProviderCatalog(makeConfig());
      const provider = visible.find(
        (p) => p.id === "__test_provider_with_flagged_model__",
      );
      expect(provider).toBeDefined();
      expect(provider!.models.map((m) => m.id)).toEqual(["visible-model"]);
    } finally {
      PROVIDER_CATALOG.length = 0;
      PROVIDER_CATALOG.push(...original);
    }
  });

  test("hides a provider entirely when all its models are flagged off", () => {
    _setOverridesForTesting({
      "flag-a": false,
      "flag-b": false,
    });

    const original = [...PROVIDER_CATALOG];
    PROVIDER_CATALOG.push({
      id: "__test_all_models_flagged__",
      displayName: "All Flagged",
      models: [
        {
          id: "model-a",
          displayName: "Model A",
          featureFlag: "flag-a",
        },
        {
          id: "model-b",
          displayName: "Model B",
          featureFlag: "flag-b",
        },
      ],
      defaultModel: "model-a",
    });

    try {
      const visible = getVisibleProviderCatalog(makeConfig());
      expect(
        visible.find((p) => p.id === "__test_all_models_flagged__"),
      ).toBeUndefined();
    } finally {
      PROVIDER_CATALOG.length = 0;
      PROVIDER_CATALOG.push(...original);
    }
  });
});
