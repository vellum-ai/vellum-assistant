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
  verbosity: "medium" as const,
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
      profileOrder: [],
      callSites: {
        mainAgent: { profile: "nonexistent" },
      },
      pricingOverrides: [],
    };
    expect(() => resolveCallSiteConfig("mainAgent", llm)).toThrow(
      /references undefined profile "nonexistent"/,
    );
  });

  test("5-layer precedence: each layer overrides the prior for non-main call sites", () => {
    // Set up a config where every layer touches `model` and `effort` so we
    // can verify each layer's contribution and that higher layers win.
    //
    // Layer order (low → high):
    //   1. default          → model=claude-opus-4-7, effort=max
    //   2. activeProfile    → effort=medium  (everything else falls through)
    //   3. overrideProfile  → effort=low, speed=fast
    //   4. callSite.profile → effort=high, verbosity=high
    //   5. callSite frag    → effort=none   (top dog)
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        active: { effort: "medium" },
        override: { effort: "low", speed: "fast" },
        siteProfile: { effort: "high", verbosity: "high" },
      },
      callSites: {
        memoryExtraction: { profile: "siteProfile", effort: "none" },
      },
      activeProfile: "active",
    });

    const resolved = resolveCallSiteConfig("memoryExtraction", llm, {
      overrideProfile: "override",
    });

    // Top layer (callSite fragment) wins for `effort` over every other
    // layer's contribution (max → medium → low → high → none).
    expect(resolved.effort).toBe("none");
    // siteProfile contributes verbosity (no higher layer touches it).
    expect(resolved.verbosity).toBe("high");
    // overrideProfile contributes speed (no higher layer touches it).
    expect(resolved.speed).toBe("fast");
    // default wins for everything no higher layer touches.
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.model).toBe("claude-opus-4-7");
    expect(resolved.maxTokens).toBe(64000);
  });

  test("activeProfile applies when set with no overrideProfile and no callsite", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        balanced: { effort: "medium", verbosity: "low" },
      },
      activeProfile: "balanced",
    });
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    expect(resolved.effort).toBe("medium");
    expect(resolved.verbosity).toBe("low");
    // Default still shines through where the profile is silent.
    expect(resolved.model).toBe("claude-opus-4-7");
    expect(resolved.speed).toBe("standard");
  });

  test("overrideProfile beats activeProfile but loses to non-main callsite-level fields", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        active: { effort: "low", verbosity: "low" },
        override: { effort: "high", speed: "fast" },
      },
      callSites: {
        memoryExtraction: { effort: "none" },
      },
      activeProfile: "active",
    });
    const resolved = resolveCallSiteConfig("memoryExtraction", llm, {
      overrideProfile: "override",
    });
    // Callsite fragment wins for effort.
    expect(resolved.effort).toBe("none");
    // Override profile wins where callsite is silent.
    expect(resolved.speed).toBe("fast");
    // Active profile wins where neither override nor callsite touches.
    expect(resolved.verbosity).toBe("low");
  });

  test("overrideProfile absent leaves prior behavior intact", () => {
    // No `opts` argument at all — the resolver must behave exactly as it did
    // before this PR for configs without activeProfile/overrideProfile.
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
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.model).toBe("claude-opus-4-7");
  });

  test("overrideProfile referencing a missing key falls through silently", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        balanced: { effort: "medium" },
      },
    });
    // The schema's superRefine doesn't validate `overrideProfile` (it's a
    // runtime parameter), so a missing key must silently fall through.
    const resolved = resolveCallSiteConfig("mainAgent", llm, {
      overrideProfile: "nonexistent",
    });
    // Falls through to default — the missing override contributes nothing.
    expect(resolved.effort).toBe("max");
    expect(resolved.model).toBe("claude-opus-4-7");
  });

  test("activeProfile referencing a missing key falls through silently", () => {
    // Hand-craft an `LLMSchema`-typed object that bypasses superRefine —
    // schema validation rejects an unknown `activeProfile` at parse, but the
    // resolver itself must not throw (parity with `overrideProfile`).
    const llm: z.infer<typeof LLMSchema> = {
      default: fullDefault,
      profiles: {},
      profileOrder: [],
      callSites: {},
      activeProfile: "nonexistent",
      pricingOverrides: [],
    };
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    // Falls through to default.
    expect(resolved.effort).toBe("max");
    expect(resolved.model).toBe("claude-opus-4-7");
  });

  test("thinking and contextWindow deep-merge across all five layers for non-main call sites", () => {
    // Each layer touches a different leaf inside `thinking` and
    // `contextWindow.overflowRecovery` so we can verify deep merge composes
    // every contribution rather than wholesale-replacing the nested objects.
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        active: {
          thinking: { enabled: false },
          contextWindow: { overflowRecovery: { maxAttempts: 7 } },
        },
        override: {
          thinking: { streamThinking: false },
          contextWindow: { overflowRecovery: { safetyMarginRatio: 0.1 } },
        },
        siteProfile: {
          contextWindow: { targetBudgetRatio: 0.5 },
        },
      },
      callSites: {
        memoryExtraction: {
          profile: "siteProfile",
          contextWindow: { compactThreshold: 0.9 },
        },
      },
      activeProfile: "active",
    });
    const resolved = resolveCallSiteConfig("memoryExtraction", llm, {
      overrideProfile: "override",
    });
    // Each layer's leaf survives because no higher layer touches it.
    expect(resolved.thinking.enabled).toBe(false); // active
    expect(resolved.thinking.streamThinking).toBe(false); // override
    expect(resolved.contextWindow.overflowRecovery.maxAttempts).toBe(7); // active
    expect(resolved.contextWindow.overflowRecovery.safetyMarginRatio).toBe(0.1); // override
    expect(resolved.contextWindow.targetBudgetRatio).toBe(0.5); // siteProfile
    expect(resolved.contextWindow.compactThreshold).toBe(0.9); // callsite
    // Untouched leaves at depth 2 fall through to default.
    expect(resolved.contextWindow.overflowRecovery.enabled).toBe(true);
    expect(
      resolved.contextWindow.overflowRecovery.interactiveLatestTurnCompression,
    ).toBe("summarize");
    // Untouched leaves at depth 1 fall through to default.
    expect(resolved.contextWindow.maxInputTokens).toBe(200000);
    expect(resolved.contextWindow.summaryBudgetRatio).toBe(0.05);
  });

  test("callSite fragment fields still win at the top for non-main call sites", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        active: { model: "active-model", effort: "low" },
        override: { model: "override-model", speed: "fast" },
        siteProfile: { model: "siteProfile-model", verbosity: "high" },
      },
      callSites: {
        memoryExtraction: {
          profile: "siteProfile",
          model: "site-model",
          maxTokens: 12345,
        },
      },
      activeProfile: "active",
    });
    const resolved = resolveCallSiteConfig("memoryExtraction", llm, {
      overrideProfile: "override",
    });
    // Site fragment wins for fields it sets.
    expect(resolved.model).toBe("site-model");
    expect(resolved.maxTokens).toBe(12345);
    // Lower layers contribute fields the site fragment does not touch.
    expect(resolved.verbosity).toBe("high"); // from siteProfile
    expect(resolved.speed).toBe("fast"); // from override
    expect(resolved.effort).toBe("low"); // from active
  });

  test("mainAgent activeProfile overrides static call-site defaults", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        balanced: {
          provider: "openai",
          model: "gpt-5.4",
          maxTokens: 16000,
          contextWindow: { maxInputTokens: 400000 },
        },
      },
      callSites: {
        mainAgent: {
          provider: "anthropic",
          model: "claude-opus-4-7",
          maxTokens: 32000,
          contextWindow: { maxInputTokens: 200000 },
        },
      },
      activeProfile: "balanced",
    });

    const resolved = resolveCallSiteConfig("mainAgent", llm);

    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toBe("gpt-5.4");
    expect(resolved.maxTokens).toBe(16000);
    expect(resolved.contextWindow.maxInputTokens).toBe(400000);
  });

  test("mainAgent overrideProfile beats activeProfile and static call-site defaults", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        active: {
          provider: "openai",
          model: "gpt-5.4",
          maxTokens: 16000,
          contextWindow: { maxInputTokens: 400000 },
        },
        pinned: {
          provider: "gemini",
          model: "gemini-2.5-pro",
          maxTokens: 65536,
          contextWindow: { maxInputTokens: 1048576 },
        },
      },
      callSites: {
        mainAgent: {
          provider: "anthropic",
          model: "claude-opus-4-7",
          maxTokens: 32000,
          contextWindow: { maxInputTokens: 200000 },
        },
      },
      activeProfile: "active",
    });

    const resolved = resolveCallSiteConfig("mainAgent", llm, {
      overrideProfile: "pinned",
    });

    expect(resolved.provider).toBe("gemini");
    expect(resolved.model).toBe("gemini-2.5-pro");
    expect(resolved.maxTokens).toBe(65536);
    expect(resolved.contextWindow.maxInputTokens).toBe(1048576);
  });
});
