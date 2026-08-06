import { describe, expect, test } from "bun:test";

import { LLMConfigBase, LLMSchema } from "../config/schemas/llm.js";

// A legacy `llm.default` blob as older configs persisted it. The schema has
// no `default` field, so Zod strips the key at parse time — configs carrying
// it must still load, with the blob ignored.
const legacyDefaultBlob = {
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
  test("valid full config parses successfully; a legacy `default` blob is ignored", () => {
    const parsed = LLMSchema.parse({
      default: legacyDefaultBlob,
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
    // The schema has no `default` field; Zod strips the unknown key.
    expect("default" in parsed).toBe(false);
    expect(parsed.profiles["fast"]?.speed).toBe("fast");
    expect(parsed.profileOrder).toEqual([]);
    expect(parsed.callSites.mainAgent?.profile).toBe("thorough");
    expect(parsed.pricingOverrides).toHaveLength(1);
  });

  test("a config carrying only a legacy `llm.default` blob parses with the key dropped", () => {
    const parsed = LLMSchema.parse({ default: legacyDefaultBlob });
    expect("default" in parsed).toBe(false);
    expect(parsed.profiles).toEqual({});
    expect(parsed.profileOrder).toEqual([]);
    expect(parsed.callSites).toEqual({});
    expect(parsed.pricingOverrides).toEqual([]);
  });

  test("empty `llm: {}` parses with all schema defaults applied", () => {
    const parsed = LLMSchema.parse({});
    expect(parsed.profiles).toEqual({});
    expect(parsed.profileOrder).toEqual([]);
    expect(parsed.callSites).toEqual({});
    expect(parsed.pricingOverrides).toEqual([]);
    expect(parsed.profileSession).toEqual({
      defaultTtlSeconds: 1800,
      maxTtlSeconds: 43200,
    });
  });

  test("LLMConfigBase.parse({}) returns a fully-defaulted object", () => {
    // Critical regression guard: every leaf of LLMConfigBase has a
    // schema-level default, so `LLMConfigBase.parse({})` must return a
    // fully-populated object. The resolver composes every resolved call-site
    // config over this code-owned base, and the loader's leaf-deletion
    // recovery path relies on schema-level defaults to repair partially
    // invalid `llm` blocks instead of falling through to
    // `cloneDefaultConfig()` and discarding unrelated valid settings.
    expect(LLMConfigBase.parse({})).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-8",
      maxTokens: 64000,
      effort: "max",
      speed: "standard",
      verbosity: "medium",
      temperature: null,
      topP: null,
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
  });

  test("profileOrder accepts presentation order without requiring matching profiles", () => {
    const parsed = LLMSchema.parse({
      profiles: { fast: { speed: "fast" } },
      profileOrder: ["fast", "stale"],
    });
    expect(parsed.profileOrder).toEqual(["fast", "stale"]);
  });

  test("invalid provider rejected", () => {
    const result = LLMSchema.safeParse({
      profiles: { mine: { provider: "bogus-provider" } },
    });
    expect(result.success).toBe(false);
  });

  test("invalid temperature (negative) rejected", () => {
    const result = LLMSchema.safeParse({
      profiles: { mine: { temperature: -0.1 } },
    });
    expect(result.success).toBe(false);
  });

  test("invalid temperature (> 2) rejected", () => {
    const result = LLMSchema.safeParse({
      profiles: { mine: { temperature: 2.5 } },
    });
    expect(result.success).toBe(false);
  });

  test("call-site referencing undefined profile fails superRefine", () => {
    const result = LLMSchema.safeParse({
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
      profiles: { fast: { speed: "fast" } },
      callSites: {
        mainAgent: { profile: "fast" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("unknown call-site key (typo) fails Zod parse", () => {
    const result = LLMSchema.safeParse({
      callSites: {
        // typo of `mainAgent`
        mainAgnt: { temperature: 0.5 },
      },
    });
    expect(result.success).toBe(false);
  });

  test("thinking partial override accepted (only `enabled`, no `streamThinking`)", () => {
    const result = LLMSchema.safeParse({
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

  test("openrouter.only accepts a list of provider names in profile/callSite", () => {
    const parsed = LLMSchema.parse({
      profiles: {
        pinned: { openrouter: { only: ["Anthropic"] } },
      },
      callSites: {
        mainAgent: { openrouter: { only: ["Google"] } },
      },
    });
    expect(parsed.profiles["pinned"]?.openrouter?.only).toEqual(["Anthropic"]);
    expect(parsed.callSites.mainAgent?.openrouter?.only).toEqual(["Google"]);
  });

  test("openrouter.only rejects empty string entries", () => {
    const result = LLMSchema.safeParse({
      profiles: { pinned: { openrouter: { only: [""] } } },
    });
    expect(result.success).toBe(false);
  });

  test("activeProfile undefined parses fine", () => {
    const result = LLMSchema.safeParse({
      profiles: { fast: { speed: "fast" } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.activeProfile).toBeUndefined();
    }
  });

  test("activeProfile referencing existing profile parses fine", () => {
    const result = LLMSchema.safeParse({
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

  test("profile contextWindow with targetBudgetRatio >= compactThreshold fails cross-field validation", () => {
    const result = LLMSchema.safeParse({
      profiles: {
        inverted: {
          contextWindow: { targetBudgetRatio: 0.8, compactThreshold: 0.3 },
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message).join("\n")).toContain(
        "targetBudgetRatio must be less than contextWindow.compactThreshold",
      );
    }
  });

  test("call-site contextWindow with targetBudgetRatio <= summaryBudgetRatio fails cross-field validation", () => {
    const result = LLMSchema.safeParse({
      callSites: {
        mainAgent: {
          contextWindow: { targetBudgetRatio: 0.05, summaryBudgetRatio: 0.3 },
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message).join("\n")).toContain(
        "targetBudgetRatio must be greater than contextWindow.summaryBudgetRatio",
      );
    }
  });

  test("partial contextWindow with only one side of a cross-field pair passes", () => {
    const result = LLMSchema.safeParse({
      profiles: {
        partial: {
          contextWindow: { targetBudgetRatio: 0.9 },
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
