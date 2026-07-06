import { describe, expect, test } from "bun:test";

import { z } from "zod";

import {
  resolveCallSiteConfig,
  resolveDefaultProfileKey,
} from "../config/llm-resolver.js";
import { type LLMCallSite, LLMSchema } from "../config/schemas/llm.js";

const fullDefault = {
  provider: "anthropic" as const,
  model: "claude-opus-4-7",
  maxTokens: 64000,
  effort: "max" as const,
  speed: "standard" as const,
  verbosity: "medium" as const,
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
      interactiveLatestTurnCompression: "summarize" as const,
      nonInteractiveLatestTurnCompression: "truncate" as const,
    },
  },
  openrouter: { only: [] as string[] },
};

describe("resolveCallSiteConfig", () => {
  test("returns default when the call-site default profile is disabled and no custom fallback exists", () => {
    // mainAgent's catalog default (`balanced`) is always resolvable from the
    // code catalog, so the pure fall-through-to-default path requires it to
    // be disabled (the BYOK hatch state) with no `custom-balanced` present.
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: { balanced: { source: "managed", status: "disabled" } },
    });
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

  test("model-only call-site override infers provider from known model owner", () => {
    const llm = LLMSchema.parse({
      default: {
        ...fullDefault,
        provider: "openai",
        model: "gpt-5.5",
      },
      profiles: {
        active: { provider: "openai", model: "gpt-5.5" },
      },
      activeProfile: "active",
      callSites: {
        conversationStarters: {
          model: "claude-haiku-4-5-20251001",
          effort: "low",
        },
      },
    });

    const resolved = resolveCallSiteConfig("conversationStarters", llm);

    expect(resolved.provider).toBe("anthropic");
    expect(resolved.model).toBe("claude-haiku-4-5-20251001");
    expect(resolved.effort).toBe("low");
  });

  test("unknown model-only override preserves inherited provider", () => {
    const llm = LLMSchema.parse({
      default: {
        ...fullDefault,
        provider: "openai",
        model: "gpt-5.5",
      },
      callSites: {
        memoryExtraction: { model: "local-custom-model" },
      },
    });

    const resolved = resolveCallSiteConfig("memoryExtraction", llm);

    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toBe("local-custom-model");
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

  test("topP defaults to null when no profile or override sets it", () => {
    const llm = LLMSchema.parse({ default: fullDefault });
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    expect(resolved.topP).toBeNull();
  });

  test("profile-level topP resolves onto the merged config", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        nucleus: { topP: 0.9 },
      },
      callSites: {
        memoryExtraction: { profile: "nucleus" },
      },
    });
    const resolved = resolveCallSiteConfig("memoryExtraction", llm);
    expect(resolved.topP).toBe(0.9);
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
      profileSession: { defaultTtlSeconds: 1800, maxTtlSeconds: 43200 },
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

  test("forceOverrideProfile floats the override profile above site profile and callsite fields for non-main call sites", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        active: { verbosity: "low" },
        sitep: { effort: "none", speed: "fast" },
        forced: {
          model: "claude-haiku-4-5",
          effort: "high",
          thinking: { enabled: false },
        },
      },
      callSites: {
        memoryExtraction: { profile: "sitep", maxTokens: 1000 },
      },
      activeProfile: "active",
    });
    const resolved = resolveCallSiteConfig("memoryExtraction", llm, {
      overrideProfile: "forced",
      forceOverrideProfile: true,
    });
    // Forced override wins over both the site profile and the call-site
    // override fields it touches.
    expect(resolved.model).toBe("claude-haiku-4-5");
    expect(resolved.effort).toBe("high");
    expect(resolved.thinking.enabled).toBe(false);
    // Call-site layers still win where the forced profile is silent.
    expect(resolved.maxTokens).toBe(1000);
    expect(resolved.speed).toBe("fast");
    // Active profile still applies under everything.
    expect(resolved.verbosity).toBe("low");
  });

  test("forceOverrideProfile absent leaves the override below callsite fields (unchanged precedence)", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        forced: { effort: "high" },
      },
      callSites: {
        memoryExtraction: { effort: "none" },
      },
    });
    const resolved = resolveCallSiteConfig("memoryExtraction", llm, {
      overrideProfile: "forced",
    });
    expect(resolved.effort).toBe("none");
  });

  test("forceOverrideProfile with a missing profile reference falls through to unchanged precedence", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        sitep: { effort: "low", model: "claude-haiku-4-5" },
      },
      callSites: {
        memoryExtraction: { profile: "sitep" },
      },
    });
    const resolved = resolveCallSiteConfig("memoryExtraction", llm, {
      overrideProfile: "nonexistent",
      forceOverrideProfile: true,
    });
    // The missing reference is inert: site profile still wins.
    expect(resolved.effort).toBe("low");
    expect(resolved.model).toBe("claude-haiku-4-5");
  });

  test("forceOverrideProfile is a no-op for mainAgent (override already resolves on top)", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        active: { effort: "low" },
        override: { effort: "high" },
      },
      callSites: {
        mainAgent: { effort: "none" },
      },
      activeProfile: "active",
    });
    const withForce = resolveCallSiteConfig("mainAgent", llm, {
      overrideProfile: "override",
      forceOverrideProfile: true,
    });
    const withoutForce = resolveCallSiteConfig("mainAgent", llm, {
      overrideProfile: "override",
    });
    expect(withForce).toEqual(withoutForce);
    expect(withForce.effort).toBe("high");
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
    // overrideProfile is set so the shipped default's profile is stripped.
    // The nonexistent overrideProfile also adds nothing. Falls through to default.
    expect(resolved.effort).toBe("max");
    expect(resolved.model).toBe("claude-opus-4-7");
  });

  test("activeProfile referencing a missing key falls through silently", () => {
    // Hand-craft an `LLMSchema`-typed object that bypasses superRefine —
    // schema validation rejects an unknown `activeProfile` at parse, but the
    // resolver itself must not throw (parity with `overrideProfile`).
    const llm: z.infer<typeof LLMSchema> = {
      default: fullDefault,
      // Disable the catalog default so the missing activeProfile's silent
      // fall-through lands on `llm.default` rather than catalog `balanced`.
      profiles: { balanced: { source: "managed", status: "disabled" } },
      profileOrder: [],
      callSites: {},
      activeProfile: "nonexistent",
      profileSession: { defaultTtlSeconds: 1800, maxTtlSeconds: 43200 },
      pricingOverrides: [],
    };
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    // Falls through to default.
    expect(resolved.effort).toBe("max");
    expect(resolved.model).toBe("claude-opus-4-7");
  });

  test("thinking and contextWindow deep-merge across the contributing layers for non-main call sites", () => {
    // Each layer touches a different leaf inside `thinking` and
    // `contextWindow.overflowRecovery` so we can verify deep merge composes
    // every contribution rather than wholesale-replacing the nested objects.
    // The call site pins `siteProfile`, so the active profile is excluded — its
    // leaves fall through to default while override, site profile, and the
    // call-site fragment still compose.
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
    // Override, site profile, and the call-site fragment each contribute a leaf.
    expect(resolved.thinking.streamThinking).toBe(false); // override
    expect(resolved.contextWindow.overflowRecovery.safetyMarginRatio).toBe(0.1); // override
    expect(resolved.contextWindow.targetBudgetRatio).toBe(0.5); // siteProfile
    expect(resolved.contextWindow.compactThreshold).toBe(0.9); // callsite
    // The active profile is excluded (the call site pins its own profile), so
    // its leaves fall through to default instead of contributing.
    expect(resolved.thinking.enabled).toBe(true); // default, NOT active's false
    expect(resolved.contextWindow.overflowRecovery.maxAttempts).toBe(3); // default, NOT active's 7
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
    // The active profile is excluded when the call site pins its own profile,
    // so `effort` falls through to default rather than active's "low".
    expect(resolved.effort).toBe("max"); // default, NOT active's "low"
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

  test("call site with no explicit config falls back to CALL_SITE_DEFAULTS", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        "cost-optimized": {
          model: "claude-haiku-4-5-20251001",
          effort: "low",
        },
      },
    });
    const resolved = resolveCallSiteConfig("memoryExtraction", llm);
    expect(resolved.model).toBe("claude-haiku-4-5-20251001");
    expect(resolved.effort).toBe("low");
  });

  test("empty-state greeting defaults to the balanced profile", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        balanced: {
          model: "claude-sonnet-4-7",
          effort: "medium",
        },
        "cost-optimized": {
          model: "claude-haiku-4-5-20251001",
          effort: "low",
        },
      },
    });

    expect(resolveDefaultProfileKey("emptyStateGreeting", llm)).toBe(
      "balanced",
    );
    const resolved = resolveCallSiteConfig("emptyStateGreeting", llm);
    expect(resolved.model).toBe("claude-sonnet-4-7");
    expect(resolved.effort).toBe("medium");
  });

  test("explicit callSites config overrides CALL_SITE_DEFAULTS", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        "cost-optimized": {
          model: "claude-haiku-4-5-20251001",
          effort: "low",
        },
        "quality-optimized": { model: "claude-opus-4-7", effort: "max" },
      },
      callSites: {
        memoryExtraction: { profile: "quality-optimized" },
      },
    });
    const resolved = resolveCallSiteConfig("memoryExtraction", llm);
    expect(resolved.model).toBe("claude-opus-4-7");
    expect(resolved.effort).toBe("max");
  });

  test("BYOK: disabled managed profile falls back to custom-* user profile", () => {
    const llm = LLMSchema.parse({
      default: {
        ...fullDefault,
        provider: "openai",
        model: "gpt-5.5",
        provider_connection: "openai-personal",
      },
      profiles: {
        "cost-optimized": {
          status: "disabled",
          model: "claude-haiku-4-5-20251001",
          provider: "anthropic",
          provider_connection: "anthropic-managed",
        },
        "custom-cost-optimized": {
          source: "user",
          model: "gpt-5.4-nano",
          provider: "openai",
          provider_connection: "openai-personal",
        },
        "custom-balanced": {
          source: "user",
          model: "gpt-5.5",
          provider: "openai",
          provider_connection: "openai-personal",
        },
      },
      activeProfile: "custom-balanced",
    });
    const resolved = resolveCallSiteConfig("memoryExtraction", llm);
    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toBe("gpt-5.4-nano");
    expect(resolved.provider_connection).toBe("openai-personal");
  });

  test("BYOK: strips profile when neither managed nor custom-* is available", () => {
    const llm = LLMSchema.parse({
      default: {
        ...fullDefault,
        provider: "openai",
        model: "gpt-5.5",
        provider_connection: "openai-personal",
      },
      profiles: {
        "cost-optimized": {
          status: "disabled",
          model: "claude-haiku-4-5-20251001",
          provider: "anthropic",
          provider_connection: "anthropic-managed",
        },
        "custom-balanced": {
          model: "gpt-5.5",
          provider: "openai",
          provider_connection: "openai-personal",
        },
      },
      activeProfile: "custom-balanced",
    });
    const resolved = resolveCallSiteConfig("memoryExtraction", llm);
    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toBe("gpt-5.5");
    expect(resolved.provider_connection).toBe("openai-personal");
  });

  test("BYOK full-workspace: cost-optimized call sites use custom-cost-optimized, balanced use custom-balanced", () => {
    const byokConfig = LLMSchema.parse({
      default: {
        ...fullDefault,
        provider: "openai",
        model: "gpt-5.5",
        provider_connection: "openai-personal",
      },
      profiles: {
        balanced: {
          status: "disabled",
          source: "managed",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          provider_connection: "anthropic-managed",
        },
        "cost-optimized": {
          status: "disabled",
          source: "managed",
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
          provider_connection: "anthropic-managed",
        },
        "quality-optimized": {
          status: "disabled",
          source: "managed",
          provider: "anthropic",
          model: "claude-opus-4-7",
          provider_connection: "anthropic-managed",
        },
        "custom-balanced": {
          source: "user",
          provider: "openai",
          model: "gpt-5.5",
          provider_connection: "openai-personal",
        },
        "custom-cost-optimized": {
          source: "user",
          provider: "openai",
          model: "gpt-5.4-nano",
          provider_connection: "openai-personal",
        },
        "custom-quality-optimized": {
          source: "user",
          provider: "openai",
          model: "gpt-5.5-pro",
          provider_connection: "openai-personal",
        },
      },
      activeProfile: "custom-balanced",
    });

    const callSites: LLMCallSite[] = [
      "mainAgent",
      "subagentSpawn",
      "heartbeatAgent",
      "filingAgent",
      "compactionAgent",
      "analyzeConversation",
      "callAgent",
      "memoryExtraction",
      "memoryConsolidation",
      "memoryRetrieval",
      "memoryRouter",
      "recall",
      "conversationSummarization",
      "commitMessage",
      "conversationStarters",
      "replySuggestion",
      "conversationTitle",
      "identityIntro",
      "emptyStateGreeting",
      "notificationDecision",
      "interactionClassifier",
      "inference",
    ];

    for (const cs of callSites) {
      const resolved = resolveCallSiteConfig(cs, byokConfig);
      expect(resolved.provider_connection).not.toBe("anthropic-managed");
      expect(resolved.provider).toBe("openai");
    }

    // Cost-optimized call sites should use the user's nano model
    const costSite = resolveCallSiteConfig("heartbeatAgent", byokConfig);
    expect(costSite.model).toBe("gpt-5.4-nano");

    // Balanced call sites should use the user's balanced model
    const balancedSite = resolveCallSiteConfig("mainAgent", byokConfig);
    expect(balancedSite.model).toBe("gpt-5.5");
  });

  test("BYOK: tuning overrides from defaults apply on top of custom-* fallback profile", () => {
    const byokConfig = LLMSchema.parse({
      default: {
        ...fullDefault,
        provider: "openai",
        model: "gpt-5.5",
        provider_connection: "openai-personal",
      },
      profiles: {
        "cost-optimized": {
          status: "disabled",
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
          provider_connection: "anthropic-managed",
        },
        "custom-cost-optimized": {
          source: "user",
          provider: "openai",
          model: "gpt-5.4-nano",
          provider_connection: "openai-personal",
        },
        "custom-balanced": {
          provider: "openai",
          model: "gpt-5.5",
          provider_connection: "openai-personal",
        },
      },
      activeProfile: "custom-balanced",
    });

    const resolved = resolveCallSiteConfig("commitMessage", byokConfig);
    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toBe("gpt-5.4-nano");
    expect(resolved.maxTokens).toBe(120);
    expect(resolved.effort).toBe("low");
    expect(resolved.thinking.enabled).toBe(false);
  });

  test("overrideProfile wins over CALL_SITE_DEFAULTS profile for non-main call sites", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        "cost-optimized": { model: "claude-haiku-4-5-20251001", effort: "low" },
        "quality-optimized": { model: "claude-opus-4-7", effort: "max" },
      },
    });
    const resolved = resolveCallSiteConfig("inference", llm, {
      overrideProfile: "quality-optimized",
    });
    expect(resolved.model).toBe("claude-opus-4-7");
    expect(resolved.effort).toBe("max");
  });

  test("profile with provider but no provider_connection inherits stale default connection (JARVIS-861)", () => {
    // This test documents the merge behavior that causes JARVIS-861: a profile
    // overrides `provider` but not `provider_connection`, so the deep merge
    // inherits a stale connection from the default layer. The fix is in the
    // dispatch layer (connection-resolution auto-resolves the mismatch).
    const llm = LLMSchema.parse({
      default: {
        ...fullDefault,
        provider_connection: "anthropic-managed",
      },
      profiles: {
        // Disable the catalog default so the stale connection under test
        // comes from `llm.default`, not the catalog `balanced` layer.
        balanced: { source: "managed", status: "disabled" },
        fireworks: {
          provider: "fireworks",
          model: "accounts/fireworks/models/kimi-k2p5",
        },
      },
      activeProfile: "fireworks",
    });

    const resolved = resolveCallSiteConfig("mainAgent", llm);

    expect(resolved.provider).toBe("fireworks");
    // The merge inherits the stale connection — the dispatch layer handles this.
    expect(resolved.provider_connection).toBe("anthropic-managed");
  });
});

describe("mix profiles", () => {
  // A mix that routes 80% to `a` (model-a) and 20% to `b` (model-b).
  const mixLlm = LLMSchema.parse({
    default: fullDefault,
    profiles: {
      a: { model: "model-a", effort: "low" },
      b: { model: "model-b", effort: "high" },
      ab: {
        mix: [
          { profile: "a", weight: 80 },
          { profile: "b", weight: 20 },
        ],
      },
    },
    activeProfile: "ab",
    // Dereference the same mix from a non-main call site so the
    // cross-call-site agreement test below exercises both deref spots.
    callSites: { memoryExtraction: { profile: "ab" } },
  });

  test("same seed resolves to the same arm (stable across calls)", () => {
    const first = resolveCallSiteConfig("mainAgent", mixLlm, {
      selectionSeed: "conv-1",
    });
    const second = resolveCallSiteConfig("mainAgent", mixLlm, {
      selectionSeed: "conv-1",
    });
    expect(first.model).toBe(second.model);
    expect(["model-a", "model-b"]).toContain(first.model);
    // The chosen arm's other fields flow through; the other arm's don't.
    if (first.model === "model-a") expect(first.effort).toBe("low");
    else expect(first.effort).toBe("high");
  });

  test("all dereference spots in a turn agree for the same seed", () => {
    // mainAgent (mix layered as activeProfile) and a non-main call site
    // resolving the same mix as its call-site profile must pick the same arm
    // when given the same conversation seed — guards the invariant that every
    // resolver call within a conversation lands on one arm.
    const main = resolveCallSiteConfig("mainAgent", mixLlm, {
      selectionSeed: "conv-xyz",
    });
    const other = resolveCallSiteConfig("memoryExtraction", mixLlm, {
      selectionSeed: "conv-xyz",
    });
    expect(other.model).toBe(main.model);
  });

  test("different seeds split across both arms by weight", () => {
    let aCount = 0;
    let bCount = 0;
    for (let i = 0; i < 400; i++) {
      const resolved = resolveCallSiteConfig("mainAgent", mixLlm, {
        selectionSeed: `conv-${i}`,
      });
      if (resolved.model === "model-a") aCount++;
      else if (resolved.model === "model-b") bCount++;
    }
    // Both arms must be reachable, and the 80/20 weighting must skew toward
    // `a`. Wide band so the assertion locks weighting without coupling to the
    // exact hash output (deterministic, so never flaky).
    expect(aCount).toBeGreaterThan(bCount);
    expect(bCount).toBeGreaterThan(0);
    expect(aCount).toBeGreaterThan(240); // ~80% of 400 = 320
    expect(aCount).toBeLessThan(390);
  });

  test("relative weights are normalized by their sum ([80,20] ≡ [4,1])", () => {
    const llm2 = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        a: { model: "model-a" },
        b: { model: "model-b" },
        ab: {
          mix: [
            { profile: "a", weight: 4 },
            { profile: "b", weight: 1 },
          ],
        },
      },
      activeProfile: "ab",
    });
    for (let i = 0; i < 200; i++) {
      const seed = `conv-${i}`;
      expect(
        resolveCallSiteConfig("mainAgent", llm2, { selectionSeed: seed }).model,
      ).toBe(
        resolveCallSiteConfig("mainAgent", mixLlm, { selectionSeed: seed })
          .model,
      );
    }
  });

  test("mix works as overrideProfile", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        a: { model: "model-a" },
        b: { model: "model-b" },
        ab: {
          mix: [
            { profile: "a", weight: 50 },
            { profile: "b", weight: 50 },
          ],
        },
      },
    });
    const resolved = resolveCallSiteConfig("mainAgent", llm, {
      overrideProfile: "ab",
      selectionSeed: "conv-1",
    });
    expect(["model-a", "model-b"]).toContain(resolved.model);
  });

  test("mix works as a call-site profile (non-mainAgent and mainAgent)", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        a: { model: "model-a" },
        b: { model: "model-b" },
        ab: {
          mix: [
            { profile: "a", weight: 50 },
            { profile: "b", weight: 50 },
          ],
        },
      },
      callSites: {
        memoryExtraction: { profile: "ab" },
        mainAgent: { profile: "ab" },
      },
    });
    expect(["model-a", "model-b"]).toContain(
      resolveCallSiteConfig("memoryExtraction", llm, { selectionSeed: "c1" })
        .model,
    );
    expect(["model-a", "model-b"]).toContain(
      resolveCallSiteConfig("mainAgent", llm, { selectionSeed: "c1" }).model,
    );
  });

  test("onMixSelected reports the mix name and the chosen arm matching the resolved model", () => {
    const calls: Array<{ mixProfile: string; chosenProfile: string }> = [];
    const resolved = resolveCallSiteConfig("mainAgent", mixLlm, {
      selectionSeed: "conv-1",
      onMixSelected: (info) => calls.push(info),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].mixProfile).toBe("ab");
    expect(["a", "b"]).toContain(calls[0].chosenProfile);
    expect(resolved.model).toBe(
      calls[0].chosenProfile === "a" ? "model-a" : "model-b",
    );
  });

  test("no seed falls back to random selection without throwing (both arms reachable)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(resolveCallSiteConfig("mainAgent", mixLlm).model);
    }
    expect(seen.has("model-a")).toBe(true);
    expect(seen.has("model-b")).toBe(true);
  });
});

describe("mix validation (LLMSchema.superRefine)", () => {
  const base = {
    default: fullDefault,
    profiles: {
      a: { model: "model-a" },
      b: { model: "model-b" },
    },
  };

  test("valid mix parses cleanly", () => {
    expect(() =>
      LLMSchema.parse({
        ...base,
        profiles: {
          ...base.profiles,
          ab: {
            mix: [
              { profile: "a", weight: 80 },
              { profile: "b", weight: 20 },
            ],
          },
        },
      }),
    ).not.toThrow();
  });

  test("rejects a mix referencing an undefined profile", () => {
    expect(() =>
      LLMSchema.parse({
        ...base,
        profiles: {
          ...base.profiles,
          ab: {
            mix: [
              { profile: "a", weight: 1 },
              { profile: "ghost", weight: 1 },
            ],
          },
        },
      }),
    ).toThrow(/not defined in llm\.profiles/);
  });

  test("rejects a nested mix (arm references another mix)", () => {
    expect(() =>
      LLMSchema.parse({
        ...base,
        profiles: {
          ...base.profiles,
          ab: {
            mix: [
              { profile: "a", weight: 1 },
              { profile: "b", weight: 1 },
            ],
          },
          outer: {
            mix: [
              { profile: "ab", weight: 1 },
              { profile: "a", weight: 1 },
            ],
          },
        },
      }),
    ).toThrow(/cannot be nested/);
  });

  test("rejects a self-referencing mix", () => {
    expect(() =>
      LLMSchema.parse({
        ...base,
        profiles: {
          ...base.profiles,
          ab: {
            mix: [
              { profile: "ab", weight: 1 },
              { profile: "a", weight: 1 },
            ],
          },
        },
      }),
    ).toThrow(/cannot reference itself/);
  });

  test("rejects a mix that also sets a config field", () => {
    expect(() =>
      LLMSchema.parse({
        ...base,
        profiles: {
          ...base.profiles,
          ab: {
            model: "model-c",
            mix: [
              { profile: "a", weight: 1 },
              { profile: "b", weight: 1 },
            ],
          },
        },
      }),
    ).toThrow(/cannot also set/);
  });

  test("rejects a mix with fewer than two arms", () => {
    expect(() =>
      LLMSchema.parse({
        ...base,
        profiles: {
          ...base.profiles,
          ab: { mix: [{ profile: "a", weight: 1 }] },
        },
      }),
    ).toThrow();
  });

  test("rejects a non-positive arm weight", () => {
    expect(() =>
      LLMSchema.parse({
        ...base,
        profiles: {
          ...base.profiles,
          ab: {
            mix: [
              { profile: "a", weight: 0 },
              { profile: "b", weight: 1 },
            ],
          },
        },
      }),
    ).toThrow();
  });
});

describe("resolveDefaultProfileKey", () => {
  test("mainAgent returns activeProfile when set and enabled", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        balanced: { provider: "anthropic", model: "claude-sonnet-4-7" },
        gemini: { provider: "gemini", model: "gemini-2.5-pro" },
      },
      activeProfile: "gemini",
    });
    expect(resolveDefaultProfileKey("mainAgent", llm)).toBe("gemini");
  });

  test("mainAgent falls back to catalog default when activeProfile is unset", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        balanced: { provider: "anthropic", model: "claude-sonnet-4-7" },
      },
    });
    // mainAgent's CALL_SITE_DEFAULTS profile is `balanced`.
    expect(resolveDefaultProfileKey("mainAgent", llm)).toBe("balanced");
  });

  test("mainAgent falls back to catalog default when activeProfile points to a missing profile", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        balanced: { provider: "anthropic", model: "claude-sonnet-4-7" },
      },
    });
    // `LLMSchema.superRefine` rejects unknown `activeProfile` references at
    // config-load time, so this branch is unreachable for a parsed config.
    // Mutate after parse to exercise the resolver's defensive fall-through.
    const mutated = { ...llm, activeProfile: "does-not-exist" };
    expect(resolveDefaultProfileKey("mainAgent", mutated)).toBe("balanced");
  });

  test("mainAgent falls back to catalog default when activeProfile is disabled", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        balanced: { provider: "anthropic", model: "claude-sonnet-4-7" },
        gemini: {
          provider: "gemini",
          model: "gemini-2.5-pro",
          status: "disabled",
        },
      },
      activeProfile: "gemini",
    });
    expect(resolveDefaultProfileKey("mainAgent", llm)).toBe("balanced");
  });

  test("non-mainAgent ignores activeProfile and returns catalog default", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        balanced: { provider: "anthropic", model: "claude-sonnet-4-7" },
        "cost-optimized": { provider: "openai", model: "gpt-5-mini" },
        gemini: { provider: "gemini", model: "gemini-2.5-pro" },
      },
      activeProfile: "gemini",
    });
    // filingAgent's CALL_SITE_DEFAULTS profile is `cost-optimized` — not gemini.
    expect(resolveDefaultProfileKey("filingAgent", llm)).toBe("cost-optimized");
  });

  test("non-mainAgent falls back to custom-* when the catalog profile is disabled", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        "cost-optimized": { source: "managed", status: "disabled" },
        "custom-cost-optimized": {
          provider: "openai",
          model: "gpt-5-mini",
        },
      },
    });
    expect(resolveDefaultProfileKey("filingAgent", llm)).toBe(
      "custom-cost-optimized",
    );
  });

  test("mainAgent returns the mix key (not an arm) when activeProfile is a mix", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        a: { model: "model-a" },
        b: { model: "model-b" },
        ab: {
          mix: [
            { profile: "a", weight: 1 },
            { profile: "b", weight: 1 },
          ],
        },
      },
      activeProfile: "ab",
    });
    expect(resolveDefaultProfileKey("mainAgent", llm)).toBe("ab");
  });

  test("mainAgent falls back to catalog default when the mix activeProfile is disabled", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        balanced: { provider: "anthropic", model: "claude-sonnet-4-7" },
        a: { model: "model-a" },
        b: { model: "model-b" },
        ab: {
          status: "disabled",
          mix: [
            { profile: "a", weight: 1 },
            { profile: "b", weight: 1 },
          ],
        },
      },
      activeProfile: "ab",
    });
    expect(resolveDefaultProfileKey("mainAgent", llm)).toBe("balanced");
  });
});

describe("resolveCallSiteConfig logitBias provenance", () => {
  const kimi = "accounts/fireworks/models/kimi-k2p6";

  test("forwards logitBias from the active profile that opted in", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        "balanced-economy": {
          provider: "fireworks",
          model: kimi,
          logitBias: "suppress-cjk",
        },
      },
      activeProfile: "balanced-economy",
    });
    expect(resolveCallSiteConfig("mainAgent", llm).logitBias).toBe(
      "suppress-cjk",
    );
  });

  test("a higher-precedence override profile that omits logitBias clears it", () => {
    // Active profile opts in, but a pinned (override) Kimi profile did not —
    // the override must not inherit suppress-cjk just because it resolves to
    // Fireworks.
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        "balanced-economy": {
          provider: "fireworks",
          model: kimi,
          logitBias: "suppress-cjk",
        },
        "my-kimi": { provider: "fireworks", model: kimi },
      },
      activeProfile: "balanced-economy",
    });
    const resolved = resolveCallSiteConfig("mainAgent", llm, {
      overrideProfile: "my-kimi",
    });
    expect(resolved.logitBias).toBeUndefined();
  });

  test("does not leak the active profile's logitBias into a call site's own profile", () => {
    // For non-main call sites the call-site profile wins; since it didn't opt
    // in, the active profile's preset must not bleed through.
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        "balanced-economy": {
          provider: "fireworks",
          model: kimi,
          logitBias: "suppress-cjk",
        },
        plain: { provider: "anthropic", model: "claude-opus-4-7" },
      },
      activeProfile: "balanced-economy",
      callSites: { memoryExtraction: { profile: "plain" } },
    });
    expect(
      resolveCallSiteConfig("memoryExtraction", llm).logitBias,
    ).toBeUndefined();
  });

  test("a logitBias on a non-profile layer (llm.default) does not apply when the winning profile omits it", () => {
    const llm = LLMSchema.parse({
      default: { ...fullDefault, logitBias: "suppress-cjk" },
      profiles: { plain: { provider: "anthropic", model: "claude-opus-4-7" } },
      activeProfile: "plain",
    });
    expect(resolveCallSiteConfig("mainAgent", llm).logitBias).toBeUndefined();
  });
});

describe("resolveCallSiteConfig sampling-param provenance (temperature / top_p)", () => {
  // Mirrors production: the active `balanced` profile carries `topP: 0.95` (a
  // MiniMax tuning), while background call sites resolve to the Anthropic
  // `cost-optimized` profile. A field-by-field deep-merge would leak the active
  // profile's `top_p` onto those Anthropic requests.
  const balancedActive = LLMSchema.parse({
    default: fullDefault,
    profiles: {
      balanced: {
        provider: "together",
        model: "MiniMaxAI/MiniMax-M3",
        topP: 0.95,
      },
      "cost-optimized": {
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        effort: "low",
        thinking: { enabled: false },
      },
    },
    activeProfile: "balanced",
  });

  test("active profile's top_p does not leak into a profile-pinned call site (Option 1 + 2)", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        balanced: {
          provider: "together",
          model: "MiniMaxAI/MiniMax-M3",
          topP: 0.95,
        },
        "cost-optimized": {
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
        },
      },
      activeProfile: "balanced",
      callSites: { memoryExtraction: { profile: "cost-optimized" } },
    });
    const resolved = resolveCallSiteConfig("memoryExtraction", llm);
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.model).toBe("claude-haiku-4-5-20251001");
    // balanced (active) is shadowed by the pinned cost-optimized profile, so
    // its top_p must not ride along onto the Anthropic request.
    expect(resolved.topP).toBeNull();
  });

  test("homeGreeting / commitMessage resolve to a temperature with NO top_p", () => {
    const greeting = resolveCallSiteConfig("homeGreeting", balancedActive);
    expect(greeting.model).toBe("claude-haiku-4-5-20251001");
    // Per-call-site temperature from CALL_SITE_DEFAULTS survives.
    expect(greeting.temperature).toBe(0.7);
    // The active profile's top_p does NOT — both together would trip
    // Anthropic's "temperature and top_p cannot both be specified".
    expect(greeting.topP).toBeNull();

    const commit = resolveCallSiteConfig("commitMessage", balancedActive);
    expect(commit.temperature).toBe(0.2);
    expect(commit.topP).toBeNull();
  });

  test("profile-less call site still inherits the active profile's provider AND sampling", () => {
    // `workflowLeaf` pins no profile, so the active profile is the legitimate
    // fallback (Option 1 keeps it): it supplies provider/model and its own
    // (coherent, same-provider) sampling.
    const resolved = resolveCallSiteConfig("workflowLeaf", balancedActive);
    expect(resolved.provider).toBe("together");
    expect(resolved.model).toBe("MiniMaxAI/MiniMax-M3");
    expect(resolved.topP).toBe(0.95);
  });

  test("mainAgent keeps the active profile's top_p (balanced wins there)", () => {
    const resolved = resolveCallSiteConfig("mainAgent", balancedActive);
    expect(resolved.model).toBe("MiniMaxAI/MiniMax-M3");
    expect(resolved.topP).toBe(0.95);
  });

  test("an explicit call-site temperature override still wins over the winning profile", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: { nucleus: { topP: 0.9, temperature: 0.1 } },
      callSites: { memoryExtraction: { profile: "nucleus", temperature: 0.5 } },
    });
    const resolved = resolveCallSiteConfig("memoryExtraction", llm);
    // Call-site override wins for the field it sets.
    expect(resolved.temperature).toBe(0.5);
    // The winning profile's top_p (no call-site override) still applies.
    expect(resolved.topP).toBe(0.9);
  });

  test("a higher-precedence profile that omits top_p clears a lower profile's top_p (Option 2)", () => {
    // No site profile is involved here, so the active profile IS folded in —
    // this isolates Option 2: the override profile wins and omits top_p, so
    // balanced's 0.95 must be cleared rather than surviving the merge.
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        balanced: {
          provider: "together",
          model: "MiniMaxAI/MiniMax-M3",
          topP: 0.95,
        },
        plain: { provider: "anthropic", model: "claude-opus-4-7" },
      },
      activeProfile: "balanced",
    });
    const resolved = resolveCallSiteConfig("mainAgent", llm, {
      overrideProfile: "plain",
    });
    expect(resolved.model).toBe("claude-opus-4-7");
    expect(resolved.topP).toBeNull();
  });

  test("forceOverrideProfile: an explicit call-site temperature survives a forced profile silent on sampling", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        active: { verbosity: "low" },
        sitep: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
        forced: { model: "claude-opus-4-7", effort: "high" },
      },
      callSites: {
        memoryExtraction: {
          profile: "sitep",
          temperature: 0.7,
          maxTokens: 1000,
        },
      },
      activeProfile: "active",
    });
    const resolved = resolveCallSiteConfig("memoryExtraction", llm, {
      overrideProfile: "forced",
      forceOverrideProfile: true,
    });
    // The forced profile floats to the top for fields it sets.
    expect(resolved.model).toBe("claude-opus-4-7");
    expect(resolved.effort).toBe("high");
    // It is silent on temperature, so the deliberate call-site value survives —
    // consistent with sibling call-site fields like maxTokens (which flow
    // through the deep-merge).
    expect(resolved.temperature).toBe(0.7);
    expect(resolved.maxTokens).toBe(1000);
  });

  test("forceOverrideProfile: a forced profile that sets temperature wins over the call-site override", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        sitep: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
        forced: { model: "claude-opus-4-7", temperature: 0.1 },
      },
      callSites: {
        memoryExtraction: { profile: "sitep", temperature: 0.7 },
      },
    });
    const resolved = resolveCallSiteConfig("memoryExtraction", llm, {
      overrideProfile: "forced",
      forceOverrideProfile: true,
    });
    // The forced profile explicitly sets temperature, so it floats above the
    // call-site override.
    expect(resolved.temperature).toBe(0.1);
  });

  test("mainAgent: an explicit call-site temperature survives an active profile silent on sampling", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: { active: { model: "claude-sonnet-4-7" } },
      callSites: { mainAgent: { temperature: 0.5 } },
      activeProfile: "active",
    });
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    // The active profile floats above the call-site for mainAgent but is silent
    // on temperature, so the deliberate call-site value survives.
    expect(resolved.model).toBe("claude-sonnet-4-7");
    expect(resolved.temperature).toBe(0.5);
  });

  test("mainAgent: the active profile's explicit temperature wins over a call-site temperature", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: { active: { model: "claude-sonnet-4-7", temperature: 0.2 } },
      callSites: { mainAgent: { temperature: 0.5 } },
      activeProfile: "active",
    });
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    // For mainAgent the active profile floats above the call-site override, so
    // its explicit temperature wins.
    expect(resolved.temperature).toBe(0.2);
  });
});

describe("resolveCallSiteConfig — workflowLeaf default", () => {
  test("inherits the workspace default config rather than pinning cost-optimized", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        "cost-optimized": {
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
        },
      },
    });
    const resolved = resolveCallSiteConfig("workflowLeaf", llm);
    // No pinned profile → the model comes from llm.default, NOT the
    // `cost-optimized` profile (which is uncredentialed on a BYOK install).
    expect(resolved.model).toBe("claude-opus-4-7");
    // Call-site tuning still applies.
    expect(resolved.effort).toBe("low");
    expect(resolved.thinking?.enabled).toBe(false);
    // The call site has no implicit default profile key.
    expect(resolveDefaultProfileKey("workflowLeaf", llm)).toBeUndefined();
  });

  test("honors an explicit workflowLeaf call-site override", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        cheap: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      },
      callSites: { workflowLeaf: { profile: "cheap" } },
    });
    expect(resolveCallSiteConfig("workflowLeaf", llm).model).toBe(
      "claude-haiku-4-5-20251001",
    );
  });

  test("honors a per-call override profile (an explicit per-leaf profile)", () => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: {
        fancy: { provider: "anthropic", model: "claude-sonnet-4-7" },
      },
    });
    expect(
      resolveCallSiteConfig("workflowLeaf", llm, { overrideProfile: "fancy" })
        .model,
    ).toBe("claude-sonnet-4-7");
  });
});
