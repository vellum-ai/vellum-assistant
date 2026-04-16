import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
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

describe("resolveCallSiteConfig", () => {
  test("returns default when call site is absent and no profile", () => {
    const llm = LLMSchema.parse({ default: fullDefault });
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    expect(resolved).toEqual(fullDefault);
  });

  test("site-level field overrides default", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      callSites: {
        mainAgent: { model: "claude-sonnet-4-7" },
      },
    });
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    expect(resolved.model).toBe("claude-sonnet-4-7");
    // Sibling fields are preserved.
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.maxTokens).toBe(64000);
  });

  test("profile field overrides default when call site references it", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        fast: { speed: "fast", effort: "low" },
      },
      callSites: {
        memoryExtraction: { profile: "fast" },
      },
    });
    const resolved = resolveCallSiteConfig("memoryExtraction", llm);
    expect(resolved.speed).toBe("fast");
    expect(resolved.effort).toBe("low");
    // Untouched defaults persist.
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.model).toBe("claude-opus-4-7");
  });

  test("site field beats both profile and default (precedence test)", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        fast: { speed: "fast", effort: "low", model: "profile-model" },
      },
      callSites: {
        memoryExtraction: {
          profile: "fast",
          model: "site-model",
          effort: "high",
        },
      },
    });
    const resolved = resolveCallSiteConfig("memoryExtraction", llm);
    // Site-level wins where it sets a value.
    expect(resolved.model).toBe("site-model");
    expect(resolved.effort).toBe("high");
    // Profile wins where site is silent.
    expect(resolved.speed).toBe("fast");
    // Default wins where neither overrides.
    expect(resolved.provider).toBe("anthropic");
  });

  test("thinking.enabled override does not nuke thinking.streamThinking (deep merge)", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      callSites: {
        mainAgent: { thinking: { enabled: false } },
      },
    });
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    expect(resolved.thinking.enabled).toBe(false);
    expect(resolved.thinking.streamThinking).toBe(true);
  });

  test("contextWindow.overflowRecovery.maxAttempts override preserves siblings (depth 2 deep merge)", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      callSites: {
        mainAgent: {
          contextWindow: {
            overflowRecovery: { maxAttempts: 7 },
          },
        },
      },
    });
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    // Overridden leaf at depth 2.
    expect(resolved.contextWindow.overflowRecovery.maxAttempts).toBe(7);
    // Sibling leaves of overflowRecovery survive.
    expect(resolved.contextWindow.overflowRecovery.enabled).toBe(true);
    expect(resolved.contextWindow.overflowRecovery.safetyMarginRatio).toBe(
      0.05,
    );
    expect(
      resolved.contextWindow.overflowRecovery.interactiveLatestTurnCompression,
    ).toBe("summarize");
    expect(
      resolved.contextWindow.overflowRecovery
        .nonInteractiveLatestTurnCompression,
    ).toBe("truncate");
    // Sibling leaves of contextWindow itself survive.
    expect(resolved.contextWindow.enabled).toBe(true);
    expect(resolved.contextWindow.maxInputTokens).toBe(200000);
    expect(resolved.contextWindow.targetBudgetRatio).toBe(0.3);
  });

  test("site without profile uses only default + site overrides", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        // Defined but unused — must not leak into the resolved config.
        fast: { speed: "fast", effort: "low" },
      },
      callSites: {
        mainAgent: { temperature: 0.5 },
      },
    });
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    expect(resolved.temperature).toBe(0.5);
    // Profile fields must not appear because mainAgent didn't reference them.
    expect(resolved.speed).toBe("standard");
    expect(resolved.effort).toBe("max");
  });

  test("defensive throw on unknown profile reference (bypassing superRefine)", () => {
    // Hand-craft an `LLMSchema`-typed object that bypasses validation by
    // referencing a profile that doesn't exist in `profiles`. The schema's
    // `superRefine` would reject this at parse time, so we construct it
    // manually to exercise the defensive throw in the resolver.
    const llm: z.infer<typeof LLMSchema> = {
      default: fullDefault,
      profiles: {},
      callSites: {
        mainAgent: { profile: "nonexistent" },
      },
      pricingOverrides: [],
    };
    expect(() => resolveCallSiteConfig("mainAgent", llm)).toThrow(
      /references undefined profile "nonexistent"/,
    );
  });
});
