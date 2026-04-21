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
  openrouter: { only: [] as string[] },
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

  test("returns isolated nested objects (not aliased to llm.default)", () => {
    // Resolve a call site that has no override touching `thinking` or
    // `contextWindow` — the bug being guarded against would have those
    // nested objects aliased directly to `llm.default`. We resolve once,
    // mutate the returned config's nested objects, then resolve again and
    // verify the second call sees the original `llm.default` values
    // (i.e. the source was never corrupted).
    const llm = LLMSchema.parse({ default: fullDefault });

    const first = resolveCallSiteConfig("mainAgent", llm);
    expect(first.thinking.enabled).toBe(true);
    expect(first.contextWindow.overflowRecovery.maxAttempts).toBe(3);

    // Mutate the result. If nested objects were aliased into `llm.default`,
    // these writes would silently corrupt the source config.
    first.thinking.enabled = false;
    first.contextWindow.overflowRecovery.maxAttempts = 999;

    // Defensive: the source `fullDefault` literal should be untouched.
    expect(fullDefault.thinking.enabled).toBe(true);
    expect(fullDefault.contextWindow.overflowRecovery.maxAttempts).toBe(3);

    // The real test: resolving the same call site again must see the
    // original `llm.default` values, not the mutations applied to `first`.
    const second = resolveCallSiteConfig("mainAgent", llm);
    expect(second.thinking.enabled).toBe(true);
    expect(second.contextWindow.overflowRecovery.maxAttempts).toBe(3);

    // Sanity: the two resolutions must return distinct nested object
    // references — otherwise the mutation on `first` would have been
    // visible on `second` and the previous assertions would have failed,
    // but assert it explicitly so the isolation contract is documented.
    expect(second.thinking).not.toBe(first.thinking);
    expect(second.contextWindow).not.toBe(first.contextWindow);
    expect(second.contextWindow.overflowRecovery).not.toBe(
      first.contextWindow.overflowRecovery,
    );
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
