import { describe, expect, test } from "bun:test";

import { z } from "zod";

import { CODE_DEFAULT_PROFILE_ENTRIES } from "../config/default-profile-catalog.js";
import {
  type ResolutionFallbackReason,
  resolveCallSiteConfig,
  resolveDefaultProfileKey,
  resolveEffectiveProfileKey,
} from "../config/llm-resolver.js";
import { type LLMCallSite, LLMSchema } from "../config/schemas/llm.js";
import { resolveModelIntent } from "../providers/model-intents.js";

// Pins the single-winner call-site resolution semantics. The core selection
// chain (override → active → call-site profile → default intent → anchor) is
// also pinned by llm-resolver-override-or-default.test.ts; this suite covers
// composition, fixtures with user profile shadows, mixes, and provenance.

// Fully-specified call-site fragment. The call-site tweak is applied last in
// the base + winner + tweak composition, so this fragment pins every knob of
// the resolved config regardless of the winning profile.
const fullTweak = {
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

type Fallback = {
  callSite: string;
  requested: string;
  reason: ResolutionFallbackReason;
};

const collect = () => {
  const fallbacks: Fallback[] = [];
  return {
    fallbacks,
    opts: {
      onResolutionFallback: (info: Fallback) => fallbacks.push(info),
    },
  };
};

describe("resolveCallSiteConfig", () => {
  test("a full call-site tweak determines every field of the resolved config", () => {
    const llm = LLMSchema.parse({
      callSites: { mainAgent: fullTweak },
    });
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    // The tweak is the last composition layer, so it wins every field it sets
    // over the winning profile's fragment.
    expect(resolved).toMatchObject(fullTweak);
  });

  test("a single call-site tweak field overrides the winner while siblings survive", () => {
    const llm = LLMSchema.parse({
      callSites: {
        mainAgent: { ...fullTweak, model: "claude-sonnet-4-7" },
      },
    });
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    expect(resolved.model).toBe("claude-sonnet-4-7");
    // Sibling tweak fields are preserved.
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.maxTokens).toBe(64000);
  });

  test("model-only call-site override infers provider from known model owner", () => {
    // The winner resolves through the openai default provider; the tweak's
    // model belongs to anthropic's catalog, so the catalog owner is implied.
    const llm = LLMSchema.parse({
      defaultProvider: { provider: "openai" },
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

  test("model-only override of a shared gateway model keeps a vercel-ai-gateway winner", () => {
    // `anthropic/claude-opus-4.8` is listed by both openrouter and
    // vercel-ai-gateway; the winner's provider serves it, so no provider is
    // implied and the winner's provider stands.
    const llm = LLMSchema.parse({
      profiles: {
        gw: {
          provider: "vercel-ai-gateway",
          model: "anthropic/claude-sonnet-4.6",
        },
      },
      callSites: {
        memoryExtraction: { profile: "gw", model: "anthropic/claude-opus-4.8" },
      },
    });

    const resolved = resolveCallSiteConfig("memoryExtraction", llm);

    expect(resolved.provider).toBe("vercel-ai-gateway");
    expect(resolved.model).toBe("anthropic/claude-opus-4.8");
  });

  test("model-only override of a shared gateway model keeps an openrouter winner", () => {
    const llm = LLMSchema.parse({
      profiles: {
        gw: { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
      },
      callSites: {
        memoryExtraction: { profile: "gw", model: "anthropic/claude-opus-4.8" },
      },
    });

    const resolved = resolveCallSiteConfig("memoryExtraction", llm);

    expect(resolved.provider).toBe("openrouter");
    expect(resolved.model).toBe("anthropic/claude-opus-4.8");
  });

  test("model-only override of a gateway model with a non-serving winner implies the catalog owner", () => {
    // Anthropic's own catalog uses bare slugs, so it does not serve
    // `anthropic/claude-sonnet-4.6` — the catalog owner (openrouter, the
    // earliest entry listing it) is implied.
    const llm = LLMSchema.parse({
      defaultProvider: { provider: "anthropic" },
      callSites: {
        memoryExtraction: { model: "anthropic/claude-sonnet-4.6" },
      },
    });

    const resolved = resolveCallSiteConfig("memoryExtraction", llm);

    expect(resolved.provider).toBe("openrouter");
    expect(resolved.model).toBe("anthropic/claude-sonnet-4.6");
  });

  test("model unique to vercel-ai-gateway implies vercel-ai-gateway", () => {
    const llm = LLMSchema.parse({
      defaultProvider: { provider: "anthropic" },
      callSites: {
        memoryExtraction: { model: "openai/gpt-5.5-pro" },
      },
    });

    const resolved = resolveCallSiteConfig("memoryExtraction", llm);

    expect(resolved.provider).toBe("vercel-ai-gateway");
    expect(resolved.model).toBe("openai/gpt-5.5-pro");
  });

  test("unknown model-only override preserves the winner's provider", () => {
    const llm = LLMSchema.parse({
      defaultProvider: { provider: "openai" },
      callSites: {
        memoryExtraction: { model: "local-custom-model" },
      },
    });

    const resolved = resolveCallSiteConfig("memoryExtraction", llm);

    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toBe("local-custom-model");
  });

  test("a call-site profile supplies the config; untouched fields fall to schema defaults", () => {
    const llm = LLMSchema.parse({
      profiles: {
        fast: {
          provider: "anthropic",
          model: "claude-opus-4-7",
          speed: "fast",
          effort: "low",
        },
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
    // Fields nobody set fall to the code-owned schema defaults.
    expect(resolved.maxTokens).toBe(64000);
    expect(resolved.verbosity).toBe("medium");
  });

  test("site field beats the winning profile (precedence test)", () => {
    const llm = LLMSchema.parse({
      profiles: {
        fast: {
          provider: "anthropic",
          model: "profile-model",
          speed: "fast",
          effort: "low",
        },
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
    // The winning profile wins where the site is silent.
    expect(resolved.speed).toBe("fast");
    expect(resolved.provider).toBe("anthropic");
  });

  test("thinking.enabled override does not nuke thinking.streamThinking (deep merge)", () => {
    const llm = LLMSchema.parse({
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
    // Sibling leaves of overflowRecovery survive from the schema-default base.
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

  test("a defined-but-unreferenced profile never leaks into the resolved config", () => {
    const llm = LLMSchema.parse({
      defaultProvider: { provider: "anthropic" },
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
    // The unused profile's fields must not appear: `speed` falls to the base
    // and `effort` comes from the winning balanced-intent profile.
    expect(resolved.speed).toBe("standard");
    expect(resolved.effort).toBe("high");
  });

  test("topP defaults to null when no profile or override sets it", () => {
    const llm = LLMSchema.parse({});
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    expect(resolved.topP).toBeNull();
  });

  test("winning-profile topP resolves onto the merged config", () => {
    const llm = LLMSchema.parse({
      profiles: {
        nucleus: { provider: "anthropic", model: "claude-opus-4-7", topP: 0.9 },
      },
      callSites: {
        memoryExtraction: { profile: "nucleus" },
      },
    });
    const resolved = resolveCallSiteConfig("memoryExtraction", llm);
    expect(resolved.topP).toBe(0.9);
  });

  test("returns isolated nested objects (not aliased to the winning profile)", () => {
    // Resolve a call site whose winner supplies nested `thinking` and
    // `contextWindow` fragments. The bug being guarded against would have
    // those nested objects aliased to the profile entry in `llm.profiles`.
    // We resolve once, mutate the returned config's nested objects, then
    // resolve again and verify the second call sees the original values
    // (i.e. the source config was never corrupted).
    const llm = LLMSchema.parse({
      profiles: {
        mine: {
          provider: "anthropic",
          model: "claude-opus-4-7",
          thinking: { enabled: true, streamThinking: true },
          contextWindow: { overflowRecovery: { maxAttempts: 3 } },
        },
      },
      activeProfile: "mine",
    });

    const first = resolveCallSiteConfig("mainAgent", llm);
    expect(first.thinking.enabled).toBe(true);
    expect(first.contextWindow.overflowRecovery.maxAttempts).toBe(3);

    // Mutate the result. If nested objects were aliased into the profile,
    // these writes would silently corrupt the source config.
    first.thinking.enabled = false;
    first.contextWindow.overflowRecovery.maxAttempts = 999;

    // Defensive: the source profile entry should be untouched.
    expect(llm.profiles["mine"]?.thinking?.enabled).toBe(true);
    expect(
      llm.profiles["mine"]?.contextWindow?.overflowRecovery?.maxAttempts,
    ).toBe(3);

    // The real test: resolving the same call site again must see the
    // original profile values, not the mutations applied to `first`.
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

  test("an unknown call-site profile reference falls through with a report (bypassing superRefine)", () => {
    // Hand-craft an `LLMSchema`-typed object that bypasses validation by
    // referencing a profile that doesn't exist in `profiles`. The schema's
    // `superRefine` would reject this at parse time, so we construct it
    // manually to exercise the resolver's silent fall-through: the missing
    // rung is reported and resolution lands on the code-owned anchor.
    const llm: z.infer<typeof LLMSchema> = {
      profiles: {},
      profileOrder: [],
      callSites: {
        mainAgent: { profile: "nonexistent" },
      },
      profileSession: { defaultTtlSeconds: 1800, maxTtlSeconds: 43200 },
      pricingOverrides: [],
    };
    const { fallbacks, opts } = collect();
    const resolved = resolveCallSiteConfig("mainAgent", llm, opts);
    expect(resolved.model).toBe(
      CODE_DEFAULT_PROFILE_ENTRIES.balanced.model as string,
    );
    expect(fallbacks).toContainEqual({
      callSite: "mainAgent",
      requested: "nonexistent",
      reason: "missing",
    });
  });

  test("activeProfile applies for mainAgent when set with no overrideProfile and no callsite", () => {
    const llm = LLMSchema.parse({
      profiles: {
        mine: {
          provider: "anthropic",
          model: "claude-sonnet-4-7",
          effort: "medium",
          verbosity: "low",
        },
      },
      activeProfile: "mine",
    });
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    expect(resolved.effort).toBe("medium");
    expect(resolved.verbosity).toBe("low");
    expect(resolved.model).toBe("claude-sonnet-4-7");
    // The base still shines through where the winner is silent.
    expect(resolved.speed).toBe("standard");
  });

  test("call-site tweak fields apply over the override winner; shadowed profiles contribute nothing", () => {
    const llm = LLMSchema.parse({
      profiles: {
        active: {
          provider: "anthropic",
          model: "active-model",
          effort: "low",
          verbosity: "low",
        },
        override: {
          provider: "anthropic",
          model: "override-model",
          effort: "high",
          speed: "fast",
        },
      },
      callSites: {
        memoryExtraction: { effort: "none" },
      },
      activeProfile: "active",
    });
    const resolved = resolveCallSiteConfig("memoryExtraction", llm, {
      overrideProfile: "override",
    });
    // The call-site tweak is the last composition layer.
    expect(resolved.effort).toBe("none");
    // The override profile is the single winner.
    expect(resolved.model).toBe("override-model");
    expect(resolved.speed).toBe("fast");
    // The active profile is not the winner, so its fields never contribute —
    // verbosity falls to the schema default.
    expect(resolved.verbosity).toBe("medium");
  });

  test("call-site tweak fields apply on top of the override winner regardless of forceOverrideProfile", () => {
    const llm = LLMSchema.parse({
      profiles: {
        forced: {
          provider: "anthropic",
          model: "claude-opus-4-7",
          effort: "high",
        },
      },
      callSites: {
        memoryExtraction: { effort: "none" },
      },
    });
    const plain = resolveCallSiteConfig("memoryExtraction", llm, {
      overrideProfile: "forced",
    });
    const forced = resolveCallSiteConfig("memoryExtraction", llm, {
      overrideProfile: "forced",
      forceOverrideProfile: true,
    });
    // The tweak is the last layer in both cases; force is a no-op.
    expect(plain.effort).toBe("none");
    expect(plain.model).toBe("claude-opus-4-7");
    expect(forced).toEqual(plain);
  });

  test("forceOverrideProfile with a missing profile reference falls through to the call-site profile", () => {
    const llm = LLMSchema.parse({
      profiles: {
        sitep: {
          provider: "anthropic",
          effort: "low",
          model: "claude-haiku-4-5",
        },
      },
      callSites: {
        memoryExtraction: { profile: "sitep" },
      },
    });
    const resolved = resolveCallSiteConfig("memoryExtraction", llm, {
      overrideProfile: "nonexistent",
      forceOverrideProfile: true,
    });
    // The missing reference is inert: the site profile still wins.
    expect(resolved.effort).toBe("low");
    expect(resolved.model).toBe("claude-haiku-4-5");
  });

  test("forceOverrideProfile is a no-op for mainAgent (override already resolves on top)", () => {
    const llm = LLMSchema.parse({
      profiles: {
        active: {
          provider: "anthropic",
          model: "claude-sonnet-4-7",
          effort: "low",
        },
        override: {
          provider: "anthropic",
          model: "claude-opus-4-7",
          effort: "high",
        },
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

  test("overrideProfile absent leaves the call-site profile as the winner", () => {
    // No `opts` argument at all — the call-site profile wins the chain.
    const llm = LLMSchema.parse({
      profiles: {
        fast: {
          provider: "anthropic",
          model: "claude-opus-4-7",
          speed: "fast",
          effort: "low",
        },
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

  test("activeProfile referencing a missing key falls through silently", () => {
    // Hand-craft an `LLMSchema`-typed object that bypasses superRefine —
    // schema validation rejects an unknown `activeProfile` at parse, but the
    // resolver itself must not throw (parity with `overrideProfile`): the
    // missing rung is skipped and resolution lands on the balanced anchor.
    const llm: z.infer<typeof LLMSchema> = {
      profiles: {},
      profileOrder: [],
      callSites: {},
      activeProfile: "nonexistent",
      profileSession: { defaultTtlSeconds: 1800, maxTtlSeconds: 43200 },
      pricingOverrides: [],
    };
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    expect(resolved.model).toBe(
      CODE_DEFAULT_PROFILE_ENTRIES.balanced.model as string,
    );
  });

  test("mainAgent activeProfile determines identity when no explicit call-site tweak exists", () => {
    const llm = LLMSchema.parse({
      profiles: {
        balanced: {
          source: "user",
          provider: "openai",
          model: "gpt-5.4",
          maxTokens: 16000,
          contextWindow: { maxInputTokens: 400000 },
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

  test("mainAgent overrideProfile beats activeProfile", () => {
    const llm = LLMSchema.parse({
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
      profiles: {
        "cost-optimized": {
          source: "user",
          provider: "anthropic",
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
      profiles: {
        balanced: {
          source: "user",
          provider: "anthropic",
          model: "claude-sonnet-4-7",
          effort: "medium",
        },
        "cost-optimized": {
          source: "user",
          provider: "anthropic",
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
      profiles: {
        "cost-optimized": {
          source: "user",
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
          effort: "low",
        },
        "quality-optimized": {
          source: "user",
          provider: "anthropic",
          model: "claude-opus-4-7",
          effort: "max",
        },
      },
      callSites: {
        memoryExtraction: { profile: "quality-optimized" },
      },
    });
    const resolved = resolveCallSiteConfig("memoryExtraction", llm);
    expect(resolved.model).toBe("claude-opus-4-7");
    expect(resolved.effort).toBe("max");
  });

  test("BYOK: a disabled managed stub does not block resolution — the default-provider intent wins", () => {
    const llm = LLMSchema.parse({
      profiles: {
        "cost-optimized": { source: "managed", status: "disabled" },
      },
      defaultProvider: { provider: "openai" },
    });
    const resolved = resolveCallSiteConfig("memoryExtraction", llm);
    expect(resolved.provider).toBe("openai");
    expect(resolved.provider_connection).toBe("openai-personal");
    expect(resolved.model).toBe(
      resolveModelIntent("openai", "latency-optimized"),
    );
  });

  test("BYOK full-workspace: every call site resolves through the default provider, never the managed connection", () => {
    const byokConfig = LLMSchema.parse({
      profiles: {
        balanced: { source: "managed", status: "disabled" },
        "cost-optimized": { source: "managed", status: "disabled" },
        "quality-optimized": { source: "managed", status: "disabled" },
        "custom-balanced": {
          source: "user",
          provider: "openai",
          model: "gpt-5.5",
          provider_connection: "openai-personal",
        },
      },
      activeProfile: "custom-balanced",
      defaultProvider: { provider: "openai" },
    });

    const callSites: LLMCallSite[] = [
      "mainAgent",
      "subagentSpawn",
      "heartbeatAgent",
      "filingAgent",
      "compactionAgent",
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

    // Cost-optimized call sites resolve the intent through the BYOK provider.
    const costSite = resolveCallSiteConfig("heartbeatAgent", byokConfig);
    expect(costSite.model).toBe(
      resolveModelIntent("openai", "latency-optimized"),
    );

    // mainAgent uses the user's active profile.
    const balancedSite = resolveCallSiteConfig("mainAgent", byokConfig);
    expect(balancedSite.model).toBe("gpt-5.5");
  });

  test("BYOK: tuning overrides from CALL_SITE_DEFAULTS apply on top of the default-provider winner", () => {
    const byokConfig = LLMSchema.parse({
      profiles: {
        "cost-optimized": { source: "managed", status: "disabled" },
      },
      defaultProvider: { provider: "openai" },
    });

    const resolved = resolveCallSiteConfig("commitMessage", byokConfig);
    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toBe(
      resolveModelIntent("openai", "latency-optimized"),
    );
    expect(resolved.maxTokens).toBe(120);
    expect(resolved.effort).toBe("low");
    expect(resolved.thinking.enabled).toBe(false);
  });

  test("overrideProfile wins over CALL_SITE_DEFAULTS profile for non-main call sites", () => {
    const llm = LLMSchema.parse({
      profiles: {
        "cost-optimized": {
          source: "user",
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
          effort: "low",
        },
        "quality-optimized": {
          source: "user",
          provider: "anthropic",
          model: "claude-opus-4-7",
          effort: "max",
        },
      },
    });
    const resolved = resolveCallSiteConfig("inference", llm, {
      overrideProfile: "quality-optimized",
    });
    expect(resolved.model).toBe("claude-opus-4-7");
    expect(resolved.effort).toBe("max");
  });

  test("a winning profile without provider_connection resolves without one (no stale connection inheritance)", () => {
    // Single-winner selection means nothing outside the winner can supply a
    // provider connection: a profile that omits it resolves without one, and
    // dispatch auto-resolves the connection by provider (JARVIS-861).
    const llm = LLMSchema.parse({
      profiles: {
        fireworks: {
          provider: "fireworks",
          model: "accounts/fireworks/models/kimi-k2p5",
        },
      },
      activeProfile: "fireworks",
    });

    const resolved = resolveCallSiteConfig("mainAgent", llm);

    expect(resolved.provider).toBe("fireworks");
    expect(resolved.provider_connection).toBeUndefined();
  });
});

describe("mix profiles", () => {
  // A mix that routes 80% to `a` (model-a) and 20% to `b` (model-b).
  const mixLlm = LLMSchema.parse({
    profiles: {
      a: { provider: "anthropic", model: "model-a", effort: "low" },
      b: { provider: "anthropic", model: "model-b", effort: "high" },
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
    if (first.model === "model-a") {
      expect(first.effort).toBe("low");
    } else {
      expect(first.effort).toBe("high");
    }
  });

  test("all dereference spots in a turn agree for the same seed", () => {
    // mainAgent (mix as activeProfile) and a non-main call site resolving the
    // same mix as its call-site profile must pick the same arm when given the
    // same conversation seed — guards the invariant that every resolver call
    // within a conversation lands on one arm.
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
      if (resolved.model === "model-a") {
        aCount++;
      } else if (resolved.model === "model-b") {
        bCount++;
      }
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
      profiles: {
        a: { provider: "anthropic", model: "model-a" },
        b: { provider: "anthropic", model: "model-b" },
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
      profiles: {
        a: { provider: "anthropic", model: "model-a" },
        b: { provider: "anthropic", model: "model-b" },
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
      profiles: {
        a: { provider: "anthropic", model: "model-a" },
        b: { provider: "anthropic", model: "model-b" },
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
      profiles: {
        balanced: { provider: "anthropic", model: "claude-sonnet-4-7" },
        gemini: { provider: "gemini", model: "gemini-2.5-pro" },
      },
      activeProfile: "gemini",
    });
    expect(resolveDefaultProfileKey("mainAgent", llm)).toBe("gemini");
  });

  test("mainAgent falls back to the call-site intent when activeProfile is unset", () => {
    const llm = LLMSchema.parse({
      profiles: {
        balanced: { provider: "anthropic", model: "claude-sonnet-4-7" },
      },
    });
    // mainAgent's CALL_SITE_DEFAULTS profile is `balanced`.
    expect(resolveDefaultProfileKey("mainAgent", llm)).toBe("balanced");
  });

  test("mainAgent falls back to the call-site intent when activeProfile points to a missing profile", () => {
    const llm = LLMSchema.parse({
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

  test("mainAgent falls back to the call-site intent when activeProfile is disabled", () => {
    const llm = LLMSchema.parse({
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

  test("non-mainAgent ignores activeProfile and returns the call-site intent", () => {
    const llm = LLMSchema.parse({
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

  test("a disabled managed default stub does not divert the key to custom-*", () => {
    // The default intent is code-owned: a legacy disabled stub is overridden
    // by the catalog body, and the user-mutable custom-* clone never captures
    // the call site.
    const llm = LLMSchema.parse({
      profiles: {
        "cost-optimized": { source: "managed", status: "disabled" },
        "custom-cost-optimized": {
          provider: "openai",
          model: "gpt-5-mini",
        },
      },
    });
    expect(resolveDefaultProfileKey("filingAgent", llm)).toBe("cost-optimized");
  });

  test("mainAgent returns the mix key (not an arm) when activeProfile is a mix", () => {
    const llm = LLMSchema.parse({
      profiles: {
        a: { provider: "anthropic", model: "model-a" },
        b: { provider: "anthropic", model: "model-b" },
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

  test("mainAgent falls back to the call-site intent when the mix activeProfile is disabled", () => {
    const llm = LLMSchema.parse({
      profiles: {
        balanced: { provider: "anthropic", model: "claude-sonnet-4-7" },
        a: { provider: "anthropic", model: "model-a" },
        b: { provider: "anthropic", model: "model-b" },
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

describe("resolveEffectiveProfileKey", () => {
  const llm = LLMSchema.parse({
    profiles: {
      balanced: { provider: "anthropic", model: "claude-sonnet-4-7" },
      "cost-optimized": { provider: "openai", model: "gpt-5-mini" },
      pinned: { provider: "gemini", model: "gemini-2.5-pro" },
    },
    activeProfile: "balanced",
  });

  test("mainAgent: override wins over active", () => {
    expect(
      resolveEffectiveProfileKey("mainAgent", llm, {
        overrideProfile: "pinned",
      }),
    ).toBe("pinned");
  });

  test("mainAgent: active wins when no override", () => {
    expect(resolveEffectiveProfileKey("mainAgent", llm)).toBe("balanced");
  });

  test("non-mainAgent: pinned override wins over the call-site intent", () => {
    expect(
      resolveEffectiveProfileKey("filingAgent", llm, {
        overrideProfile: "pinned",
      }),
    ).toBe("pinned");
  });

  test("non-mainAgent: call-site intent when no override", () => {
    // filingAgent's CALL_SITE_DEFAULTS profile is `cost-optimized`.
    expect(resolveEffectiveProfileKey("filingAgent", llm)).toBe(
      "cost-optimized",
    );
  });

  test("non-mainAgent: the override outranks an explicit call-site profile (forced or not)", () => {
    // The override is the first rung of the selection chain on every call
    // site; `forceOverrideProfile` is a no-op.
    const withSite = LLMSchema.parse({
      ...llm,
      callSites: { filingAgent: { profile: "cost-optimized" } },
    });
    expect(
      resolveEffectiveProfileKey("filingAgent", withSite, {
        overrideProfile: "pinned",
      }),
    ).toBe("pinned");
    expect(
      resolveEffectiveProfileKey("filingAgent", withSite, {
        overrideProfile: "pinned",
        forceOverrideProfile: true,
      }),
    ).toBe("pinned");
  });
});

describe("resolveCallSiteConfig logitBias provenance", () => {
  const kimi = "accounts/fireworks/models/kimi-k2p6";

  test("forwards logitBias from the active profile that opted in", () => {
    const llm = LLMSchema.parse({
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

  test("an override profile that omits logitBias clears it", () => {
    // Active profile opts in, but a pinned (override) Kimi profile did not —
    // the override must not inherit suppress-cjk just because it resolves to
    // Fireworks.
    const llm = LLMSchema.parse({
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
});

describe("resolveCallSiteConfig sampling-param provenance (temperature / top_p)", () => {
  // Mirrors production: the user's `balanced` profile carries `topP: 0.95` (a
  // MiniMax tuning), while background call sites resolve to the Anthropic
  // `cost-optimized` profile. A cross-profile leak would put the balanced
  // profile's `top_p` onto those Anthropic requests.
  const balancedActive = LLMSchema.parse({
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

  test("active profile's top_p does not leak into a profile-pinned call site", () => {
    const llm = LLMSchema.parse({
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
    // balanced is not the winner here, so its top_p must not ride along onto
    // the Anthropic request.
    expect(resolved.topP).toBeNull();
  });

  test("homeGreeting / commitMessage resolve to a temperature with NO top_p", () => {
    const greeting = resolveCallSiteConfig("homeGreeting", balancedActive);
    expect(greeting.model).toBe("claude-haiku-4-5-20251001");
    // Per-call-site temperature from CALL_SITE_DEFAULTS survives.
    expect(greeting.temperature).toBe(0.7);
    // The balanced profile's top_p does NOT — both together would trip
    // Anthropic's "temperature and top_p cannot both be specified".
    expect(greeting.topP).toBeNull();

    const commit = resolveCallSiteConfig("commitMessage", balancedActive);
    expect(commit.temperature).toBe(0.2);
    expect(commit.topP).toBeNull();
  });

  test("a profile-less call site anchors on the balanced intent, which the user's shadow implements (provider AND sampling)", () => {
    // `workflowLeaf` pins no profile, so it anchors on the balanced intent —
    // here implemented by the user's own `balanced` shadow, which supplies
    // provider/model and its own (coherent, same-provider) sampling.
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
      profiles: {
        nucleus: {
          provider: "anthropic",
          model: "claude-opus-4-7",
          topP: 0.9,
          temperature: 0.1,
        },
      },
      callSites: { memoryExtraction: { profile: "nucleus", temperature: 0.5 } },
    });
    const resolved = resolveCallSiteConfig("memoryExtraction", llm);
    // Call-site override wins for the field it sets.
    expect(resolved.temperature).toBe(0.5);
    // The winning profile's top_p (no call-site override) still applies.
    expect(resolved.topP).toBe(0.9);
  });

  test("an override winner that omits top_p clears a shadowed profile's top_p", () => {
    // The override profile wins and omits top_p, so balanced's 0.95 must not
    // survive — only the single winner contributes sampling.
    const llm = LLMSchema.parse({
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

  test("an explicit call-site temperature survives an override winner silent on sampling", () => {
    const llm = LLMSchema.parse({
      profiles: {
        sitep: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
        forced: {
          provider: "anthropic",
          model: "claude-opus-4-7",
          effort: "high",
        },
      },
      callSites: {
        memoryExtraction: {
          profile: "sitep",
          temperature: 0.7,
          maxTokens: 1000,
        },
      },
    });
    const resolved = resolveCallSiteConfig("memoryExtraction", llm, {
      overrideProfile: "forced",
      forceOverrideProfile: true,
    });
    // The override profile is the winner for the fields it sets.
    expect(resolved.model).toBe("claude-opus-4-7");
    expect(resolved.effort).toBe("high");
    // It is silent on temperature, so the deliberate call-site value survives —
    // consistent with sibling call-site fields like maxTokens.
    expect(resolved.temperature).toBe(0.7);
    expect(resolved.maxTokens).toBe(1000);
  });

  test("mainAgent: an explicit call-site temperature survives an active profile silent on sampling", () => {
    const llm = LLMSchema.parse({
      profiles: {
        active: { provider: "anthropic", model: "claude-sonnet-4-7" },
      },
      callSites: { mainAgent: { temperature: 0.5 } },
      activeProfile: "active",
    });
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    // The active profile wins the chain but is silent on temperature, so the
    // deliberate call-site value survives.
    expect(resolved.model).toBe("claude-sonnet-4-7");
    expect(resolved.temperature).toBe(0.5);
  });

  test("mainAgent: an explicit call-site temperature tweak applies over the active profile's", () => {
    const llm = LLMSchema.parse({
      profiles: {
        active: {
          provider: "anthropic",
          model: "claude-sonnet-4-7",
          temperature: 0.2,
        },
      },
      callSites: { mainAgent: { temperature: 0.5 } },
      activeProfile: "active",
    });
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    // The call-site tweak is the last composition layer on every call site,
    // so its explicit temperature wins over the winner's.
    expect(resolved.temperature).toBe(0.5);
  });
});

describe("resolveCallSiteConfig — workflowLeaf default", () => {
  test("anchors on the balanced intent through the default provider rather than pinning cost-optimized", () => {
    const llm = LLMSchema.parse({
      profiles: {
        "cost-optimized": {
          source: "user",
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
        },
      },
      defaultProvider: { provider: "anthropic" },
    });
    const resolved = resolveCallSiteConfig("workflowLeaf", llm);
    // No pinned profile → the model comes from the balanced-intent anchor
    // through the default provider, NOT the `cost-optimized` profile.
    expect(resolved.model).toBe(resolveModelIntent("anthropic", "balanced"));
    expect(resolved.model).not.toBe("claude-haiku-4-5-20251001");
    // Call-site tuning still applies.
    expect(resolved.effort).toBe("low");
    expect(resolved.thinking?.enabled).toBe(false);
    // The call site has no implicit default profile key.
    expect(resolveDefaultProfileKey("workflowLeaf", llm)).toBeUndefined();
  });

  test("honors an explicit workflowLeaf call-site override", () => {
    const llm = LLMSchema.parse({
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
