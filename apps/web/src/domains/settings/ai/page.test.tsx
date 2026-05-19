/**
 * Pure-function tests for AI settings: token budget logic, config shape,
 * and callSite override counting.
 */

import { describe, expect, test } from "bun:test";

import { getModelsForProvider } from "@/lib/llm-model-catalog.js";

import {
  assertProvisionSuccess,
  clampTokenBudget,
  DEFAULT_CONTEXT_WINDOW_BUDGET_TOKENS,
  formatCompactTokens,
  getLongContextPricingHint,
  reconcileFromDaemonConfig,
  resolveTokenBudgetStateForModel,
} from "@/domains/settings/ai/page.js";

function requireModel(provider: string, modelId: string) {
  const model = getModelsForProvider(provider).find(({ id }) => id === modelId);
  if (!model) {
    throw new Error(`Missing test model ${provider}/${modelId}`);
  }
  return model;
}

describe("AI settings token formatting", () => {
  test("formats compact token labels used by the sliders", () => {
    expect(formatCompactTokens(64_000)).toBe("64K");
    expect(formatCompactTokens(128_000)).toBe("128K");
    expect(formatCompactTokens(200_000)).toBe("200K");
    expect(formatCompactTokens(1_000_000)).toBe("1M");
    expect(formatCompactTokens(1_050_000)).toBe("1.05M");
  });
});

describe("AI settings token budget resolution", () => {
  test("keeps the untouched context window budget at the 200K default on large-context models", () => {
    const model = requireModel("openai", "gpt-5.5");

    expect(
      resolveTokenBudgetStateForModel(model, {
        maxOutputTokens: model.maxOutputTokens,
        maxOutputTouched: false,
        contextWindowTokens: model.contextWindowTokens,
        contextWindowTouched: false,
      }).contextWindowTokens,
    ).toBe(DEFAULT_CONTEXT_WINDOW_BUDGET_TOKENS);
  });

  test("clamps output and context budgets to the selected model caps", () => {
    const model = requireModel("anthropic", "claude-haiku-4-5-20251001");

    expect(
      resolveTokenBudgetStateForModel(model, {
        maxOutputTokens: 128_000,
        maxOutputTouched: true,
        contextWindowTokens: 1_000_000,
        contextWindowTouched: true,
      }),
    ).toEqual({
      maxOutputTokens: model.maxOutputTokens,
      maxOutputTouched: true,
      contextWindowTokens: model.contextWindowTokens,
      contextWindowTouched: true,
    });
  });

  test("resets untouched max output budgets to the selected model cap", () => {
    const model = requireModel("openai", "gpt-5.5");

    expect(
      resolveTokenBudgetStateForModel(model, {
        maxOutputTokens: 64_000,
        maxOutputTouched: false,
        contextWindowTokens: model.defaultContextWindowTokens,
        contextWindowTouched: false,
      }),
    ).toEqual({
      maxOutputTokens: model.maxOutputTokens,
      maxOutputTouched: false,
      contextWindowTokens: model.defaultContextWindowTokens,
      contextWindowTouched: false,
    });
  });

});

describe("AI settings long-context pricing hint", () => {
  test("only appears after a selected budget crosses known threshold metadata", () => {
    const model = requireModel("openai", "gpt-5.5");

    expect(getLongContextPricingHint(model, 200_000)).toBeNull();
    expect(getLongContextPricingHint(model, 272_000)).toBeNull();
    expect(getLongContextPricingHint(model, 273_000)).toContain("272K");
  });

  test("stays hidden when a model has no long-context pricing threshold metadata", () => {
    // Haiku 4.5 has a 200K context window with no long-context pricing tier
    // declared in the catalog, so the hint must not render.
    const model = requireModel("anthropic", "claude-haiku-4-5-20251001");

    expect(model.longContextPricingThresholdTokens).toBeUndefined();
    expect(getLongContextPricingHint(model, model.contextWindowTokens)).toBeNull();
  });
});

describe("AI settings token clamp", () => {
  test("keeps slider values inside the allowed token range", () => {
    expect(clampTokenBudget(0, 64_000)).toBe(1_000);
    expect(clampTokenBudget(32_500.4, 64_000)).toBe(32_500);
    expect(clampTokenBudget(128_000, 64_000)).toBe(64_000);
  });
});

describe("reconcileFromDaemonConfig", () => {
  test("returns empty reconciliation for empty config", () => {
    expect(reconcileFromDaemonConfig({})).toEqual({});
  });

  test("hydrates inferenceProvider from llm.default.provider", () => {
    expect(
      reconcileFromDaemonConfig({
        llm: { default: { provider: "openai" } },
      }).inferenceProvider,
    ).toBe("openai");
  });

  test("hydrates selectedModel from llm.default.model", () => {
    expect(
      reconcileFromDaemonConfig({
        llm: { default: { model: "gpt-5.5" } },
      }).selectedModel,
    ).toBe("gpt-5.5");
  });

  test("hydrates webSearchMode from services[web-search].mode", () => {
    expect(
      reconcileFromDaemonConfig({
        services: { "web-search": { mode: "managed" } },
      }).webSearchMode,
    ).toBe("managed");
  });

  test("hydrates imageGenMode from services[image-generation].mode", () => {
    expect(
      reconcileFromDaemonConfig({
        services: { "image-generation": { mode: "your-own" } },
      }).imageGenMode,
    ).toBe("your-own");
  });

  test("ignores unknown/invalid mode values — leaves field absent so localStorage default stands", () => {
    const result = reconcileFromDaemonConfig({
      services: {
        "web-search": { mode: "bad-value" },
        "image-generation": { mode: "" },
      },
    });
    expect(result.webSearchMode).toBeUndefined();
    expect(result.imageGenMode).toBeUndefined();
  });

  test("hydrates activeProfile, profiles, and profileOrder from llm", () => {
    const result = reconcileFromDaemonConfig({
      llm: {
        activeProfile: "fast",
        profileOrder: ["fast", "precise"],
        profiles: {
          fast: { source: "managed", label: "Fast" },
          precise: { source: "user", label: "Precise" },
        },
      },
    });
    expect(result.activeProfile).toBe("fast");
    expect(result.profileOrder).toEqual(["fast", "precise"]);
    expect(result.profiles?.fast?.label).toBe("Fast");
  });

  test("preserves an explicit empty profileOrder array from daemon config", () => {
    const result = reconcileFromDaemonConfig({
      llm: { profileOrder: [] },
    });
    expect(result.profileOrder).toEqual([]);
  });
});

describe("assertProvisionSuccess", () => {
  test("does not throw when result is a success response", () => {
    expect(() => assertProvisionSuccess({ success: true })).not.toThrow();
    expect(() => assertProvisionSuccess({})).not.toThrow();
    expect(() => assertProvisionSuccess(null)).not.toThrow();
    expect(() => assertProvisionSuccess(undefined)).not.toThrow();
  });

  test("throws when server returns success=false", () => {
    expect(() => assertProvisionSuccess({ success: false })).toThrow(
      "server returned success=false",
    );
  });
});

describe("callSite override count formula", () => {
  type CallSiteEntry =
    | { profile?: string | null; provider?: string | null; model?: string | null }
    | undefined;

  function countOverrides(callSites: Record<string, CallSiteEntry>): number {
    return Object.entries(callSites).filter(
      ([id, s]) =>
        id !== "mainAgent" &&
        (s?.profile != null || s?.provider != null || s?.model != null),
    ).length;
  }

  test("counts only entries with a profile, provider, or model set", () => {
    expect(
      countOverrides({
        main: { profile: "fast" },
        sidebar: { profile: null },
        modal: undefined,
        background: {},
      }),
    ).toBe(1);
  });

  test("counts provider/model overrides even without a profile", () => {
    expect(
      countOverrides({
        main: { provider: "anthropic", model: "claude-sonnet-4-6" },
        sidebar: { profile: null },
      }),
    ).toBe(1);
  });

  test("excludes mainAgent regardless of its override fields", () => {
    expect(
      countOverrides({
        mainAgent: { provider: "openai", model: "gpt-5.5" },
        sidebar: { profile: "fast" },
      }),
    ).toBe(1);
  });

  test("returns 0 when no call sites have an override", () => {
    expect(
      countOverrides({
        main: { profile: null },
        sidebar: {},
      }),
    ).toBe(0);
  });

  test("returns 0 for an empty callSites record", () => {
    expect(countOverrides({})).toBe(0);
  });

  test("counts multiple active overrides", () => {
    expect(
      countOverrides({
        a: { profile: "fast" },
        b: { profile: "precise" },
        c: { profile: null },
        mainAgent: { provider: "openai", model: "gpt-5.5" },
      }),
    ).toBe(2);
  });
});
