import { describe, expect, test } from "bun:test";

import { LLMSchema } from "../config/schemas/llm.js";

const fullDefault = {
  provider: "anthropic" as const,
  model: "claude-opus-4-7",
  maxTokens: 64000,
  effort: "max" as const,
  speed: "standard" as const,
  temperature: null,
  thinking: { enabled: true, streamThinking: true },
  contextWindow: {
    enabled: true,
    maxInputTokens: 200000,
    targetBudgetRatio: 0.3,
    compactThreshold: 0.8,
    summaryBudgetRatio: 0.05,
    overflowRecovery: {
      enabled: true,
      safetyMarginRatio: 0.05,
      maxAttempts: 3,
      interactiveLatestTurnCompression: "summarize" as const,
      nonInteractiveLatestTurnCompression: "truncate" as const,
    },
  },
};

describe("LLMSchema", () => {
  test("valid full config parses successfully (all fields present)", () => {
    const parsed = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        fast: { speed: "fast", effort: "low" },
        thorough: { effort: "high", maxTokens: 128000 },
      },
      callSites: {
        mainAgent: { profile: "thorough" },
        memoryExtraction: { profile: "fast", temperature: 0.2 },
      },
      pricingOverrides: [
        {
          provider: "anthropic",
          modelPattern: "claude-opus-*",
          inputPer1M: 15,
          outputPer1M: 75,
        },
      ],
    });
    expect(parsed.default.provider).toBe("anthropic");
    expect(parsed.profiles["fast"]?.speed).toBe("fast");
    expect(parsed.profileOrder).toEqual([]);
    expect(parsed.callSites.mainAgent?.profile).toBe("thorough");
    expect(parsed.pricingOverrides).toHaveLength(1);
  });

  test("minimal valid config (only `default` provided) parses with profiles: {} and callSites: {}", () => {
    const parsed = LLMSchema.parse({ default: fullDefault });
    expect(parsed.profiles).toEqual({});
    expect(parsed.profileOrder).toEqual([]);
    expect(parsed.callSites).toEqual({});
    expect(parsed.pricingOverrides).toEqual([]);
  });

  test("empty `llm: {}` parses with all schema defaults applied", () => {
    // Critical regression guard: every leaf of LLMConfigBase has a
    // schema-level default, so `LLMSchema.parse({})` must return a
    // fully-populated object. This is what lets the loader's leaf-deletion
    // recovery path repair partially invalid `llm` blocks instead of falling
    // through to `cloneDefaultConfig()` and discarding unrelated valid
    // settings.
    const parsed = LLMSchema.parse({});
    expect(parsed.default).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-7",
      maxTokens: 64000,
      effort: "max",
      speed: "standard",
      verbosity: "medium",
      temperature: null,
      thinking: { enabled: true, streamThinking: true },
      contextWindow: {
        enabled: true,
        maxInputTokens: 200000,
        targetBudgetRatio: 0.3,
        compactThreshold: 0.8,
        summaryBudgetRatio: 0.05,
        overflowRecovery: {
          enabled: true,
          safetyMarginRatio: 0.05,
          maxAttempts: 3,
          interactiveLatestTurnCompression: "summarize",
          nonInteractiveLatestTurnCompression: "truncate",
        },
      },
      openrouter: { only: [] },
    });
    expect(parsed.profiles).toEqual({});
    expect(parsed.profileOrder).toEqual([]);
    expect(parsed.callSites).toEqual({});
    expect(parsed.pricingOverrides).toEqual([]);
  });

  test("profileOrder accepts presentation order without requiring matching profiles", () => {
    const parsed = LLMSchema.parse({
      default: fullDefault,
      profiles: { fast: { speed: "fast" } },
      profileOrder: ["fast", "stale"],
    });
    expect(parsed.profileOrder).toEqual(["fast", "stale"]);
  });

  test("invalid provider rejected", () => {
    const result = LLMSchema.safeParse({
      default: { ...fullDefault, provider: "bogus-provider" },
    });
    expect(result.success).toBe(false);
  });

  test("invalid temperature (negative) rejected", () => {
    const result = LLMSchema.safeParse({
      default: { ...fullDefault, temperature: -0.1 },
    });
    expect(result.success).toBe(false);
  });

  test("invalid temperature (> 2) rejected", () => {
    const result = LLMSchema.safeParse({
      default: { ...fullDefault, temperature: 2.5 },
    });
    expect(result.success).toBe(false);
  });

  test("call-site referencing undefined profile fails superRefine", () => {
    const result = LLMSchema.safeParse({
      default: fullDefault,
      profiles: { fast: { speed: "fast" } },
      callSites: {
        mainAgent: { profile: "ghost" },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.join("\n")).toContain(
        'Profile "ghost" referenced by call site "mainAgent" is not defined in llm.profiles',
      );
      const issue = result.error.issues.find(
        (i) => i.message.includes("ghost") && i.message.includes("mainAgent"),
      );
      expect(issue?.path).toEqual(["callSites", "mainAgent", "profile"]);
    }
  });

  test("call-site referencing defined profile passes", () => {
    const result = LLMSchema.safeParse({
      default: fullDefault,
      profiles: { fast: { speed: "fast" } },
      callSites: {
        mainAgent: { profile: "fast" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("unknown call-site key (typo) fails Zod parse", () => {
    const result = LLMSchema.safeParse({
      default: fullDefault,
      callSites: {
        // typo of `mainAgent`
        mainAgnt: { temperature: 0.5 },
      },
    });
    expect(result.success).toBe(false);
  });

  test("thinking partial override accepted (only `enabled`, no `streamThinking`)", () => {
    const result = LLMSchema.safeParse({
      default: fullDefault,
      profiles: {
        terse: { thinking: { enabled: false } },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.profiles["terse"]?.thinking).toEqual({
        enabled: false,
      });
    }
  });

  test("openrouter.only accepts a list of provider names in default/profile/callSite", () => {
    const parsed = LLMSchema.parse({
      default: {
        ...fullDefault,
        openrouter: { only: ["Anthropic", "Google"] },
      },
      profiles: {
        pinned: { openrouter: { only: ["Anthropic"] } },
      },
      callSites: {
        mainAgent: { openrouter: { only: ["Google"] } },
      },
    });
    expect(parsed.default.openrouter.only).toEqual(["Anthropic", "Google"]);
    expect(parsed.profiles["pinned"]?.openrouter?.only).toEqual(["Anthropic"]);
    expect(parsed.callSites.mainAgent?.openrouter?.only).toEqual(["Google"]);
  });

  test("openrouter.only rejects empty string entries", () => {
    const result = LLMSchema.safeParse({
      default: { ...fullDefault, openrouter: { only: [""] } },
    });
    expect(result.success).toBe(false);
  });

  test("activeProfile undefined parses fine", () => {
    const result = LLMSchema.safeParse({
      default: fullDefault,
      profiles: { fast: { speed: "fast" } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.activeProfile).toBeUndefined();
    }
  });

  test("activeProfile referencing existing profile parses fine", () => {
    const result = LLMSchema.safeParse({
      default: fullDefault,
      profiles: { fast: { speed: "fast" } },
      activeProfile: "fast",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.activeProfile).toBe("fast");
    }
  });

  test("activeProfile referencing missing profile fails superRefine", () => {
    const result = LLMSchema.safeParse({
      default: fullDefault,
      profiles: { fast: { speed: "fast" } },
      activeProfile: "ghost",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.join("\n")).toContain(
        'Profile "ghost" referenced by llm.activeProfile is not defined in llm.profiles',
      );
      const issue = result.error.issues.find(
        (i) =>
          i.message.includes("ghost") && i.message.includes("activeProfile"),
      );
      expect(issue?.path).toEqual(["activeProfile"]);
    }
  });

  test("contextWindow deep-partial override accepted (nested overflowRecovery only)", () => {
    const result = LLMSchema.safeParse({
      default: fullDefault,
      profiles: {
        sturdy: {
          contextWindow: {
            overflowRecovery: { maxAttempts: 5 },
          },
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const cw = result.data.profiles["sturdy"]?.contextWindow as
        | { overflowRecovery?: { maxAttempts?: number } }
        | undefined;
      expect(cw?.overflowRecovery?.maxAttempts).toBe(5);
    }
  });
});
