import { describe, expect, test } from "bun:test";

import { CODE_DEFAULT_PROFILE_ENTRIES } from "../config/default-profile-catalog.js";
import {
  type ResolutionFallbackReason,
  resolveCallSiteConfig,
  resolveDefaultProfileKey,
  selectWinningProfile,
} from "../config/llm-resolver.js";
import { LLMConfigBase, LLMSchema } from "../config/schemas/llm.js";

const schemaBase = LLMConfigBase.parse({});

// A materialized (complete) custom profile, as the ensure pass produces.
const completeCustom = {
  source: "user" as const,
  provider: "openai" as const,
  provider_connection: "openai-personal",
  model: "gpt-5.5",
  maxTokens: 9000,
  effort: "high" as const,
  speed: "standard" as const,
  verbosity: "medium" as const,
  temperature: 0.4,
  thinking: { enabled: false, streamThinking: false },
  contextWindow: schemaBase.contextWindow,
  openrouter: { only: [] as string[] },
};

const anthropicDp = { defaultProvider: { provider: "anthropic" as const } };

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

describe("selection chain", () => {
  test("an override pin wins on every call site, forced or not", () => {
    const llm = LLMSchema.parse({
      profiles: { mine: completeCustom },
      callSites: {
        conversationSummarization: { profile: "quality-optimized" },
      },
      ...anthropicDp,
    });
    for (const callSite of [
      "mainAgent",
      "conversationSummarization",
    ] as const) {
      const resolved = resolveCallSiteConfig(callSite, llm, {
        overrideProfile: "mine",
      });
      expect(resolved.model).toBe("gpt-5.5");
      expect(resolved.provider).toBe("openai");
    }
    // forceOverrideProfile is a no-op: same result with and without.
    const forced = resolveCallSiteConfig("conversationSummarization", llm, {
      overrideProfile: "mine",
      forceOverrideProfile: true,
    });
    expect(forced.model).toBe("gpt-5.5");
  });

  test("activeProfile is mainAgent-only", () => {
    const llm = LLMSchema.parse({
      profiles: { mine: completeCustom },
      activeProfile: "mine",
      ...anthropicDp,
    });
    expect(resolveCallSiteConfig("mainAgent", llm).model).toBe("gpt-5.5");
    // A background call site ignores activeProfile entirely and resolves its
    // default intent through the default provider.
    const summarized = resolveCallSiteConfig("conversationSummarization", llm);
    expect(summarized.model).not.toBe("gpt-5.5");
    expect(summarized.provider).toBe("anthropic");
  });

  test("a call-site profile beats the default intent; the default intent resolves through llm.defaultProvider", () => {
    const llm = LLMSchema.parse({
      profiles: { mine: completeCustom },
      callSites: { conversationSummarization: { profile: "mine" } },
      ...anthropicDp,
    });
    expect(resolveCallSiteConfig("conversationSummarization", llm).model).toBe(
      "gpt-5.5",
    );

    const noPin = LLMSchema.parse(anthropicDp);
    const resolved = resolveCallSiteConfig("conversationSummarization", noPin);
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.provider_connection).toBe("anthropic-personal");
  });

  test("a null defaultProvider falls back to the vellum catalog bodies", () => {
    const llm = LLMSchema.parse({});
    const resolved = resolveCallSiteConfig("conversationSummarization", llm);
    const vellumBody = CODE_DEFAULT_PROFILE_ENTRIES["cost-optimized"];
    expect(resolved.model).toBe(vellumBody.model as string);
    expect(resolved.provider_connection).toBe(vellumBody.provider_connection);
  });
});

describe("fallback and completeness", () => {
  test("a deleted override pin falls back to the call-site default with a report", () => {
    const llm = LLMSchema.parse(anthropicDp);
    const { fallbacks, opts } = collect();
    const resolved = resolveCallSiteConfig("conversationSummarization", llm, {
      overrideProfile: "deleted-profile",
      ...opts,
    });
    expect(resolved.provider).toBe("anthropic");
    expect(fallbacks).toEqual([
      {
        callSite: "conversationSummarization",
        requested: "deleted-profile",
        reason: "missing",
      },
    ]);
  });

  test("an incomplete profile never wins a rung and never fills from the base", () => {
    const llm = LLMSchema.parse({
      profiles: { partial: { source: "user", model: "gpt-5.5" } },
      ...anthropicDp,
      activeProfile: "partial",
    });
    const { fallbacks, opts } = collect();
    const resolved = resolveCallSiteConfig("mainAgent", llm, opts);
    // The base's schema-default identity must not stand in for "partial":
    // resolution lands on balanced-intent through anthropic.
    expect(resolved.model).not.toBe("gpt-5.5");
    expect(resolved.provider).toBe("anthropic");
    expect(fallbacks[0]).toEqual({
      callSite: "mainAgent",
      requested: "partial",
      reason: "incomplete",
    });
  });

  test("a disabled profile reports 'disabled' and falls through", () => {
    const llm = LLMSchema.parse({
      profiles: { mine: { ...completeCustom, status: "disabled" } },
      ...anthropicDp,
    });
    const { fallbacks, opts } = collect();
    resolveCallSiteConfig("mainAgent", llm, {
      overrideProfile: "mine",
      ...opts,
    });
    expect(fallbacks[0]?.reason).toBe("disabled");
  });

  test("no custom-* hop: a drifted custom clone does not capture a background call site", () => {
    const llm = LLMSchema.parse({
      profiles: {
        "cost-optimized": { source: "managed", status: "disabled" },
        "custom-cost-optimized": { ...completeCustom, model: "gpt-5.4" },
      },
      ...anthropicDp,
    });
    const resolved = resolveCallSiteConfig("conversationSummarization", llm);
    // The catalog intent through the default provider wins — never the
    // user-mutable custom-* clone, and the legacy disabled stub on the
    // default is overridden by the code-owned body.
    expect(resolved.model).not.toBe("gpt-5.4");
    expect(resolved.provider).toBe("anthropic");
  });
});

describe("composition", () => {
  test("base + winner + site-tweak composition (nested tweaks combine leaf-wise)", () => {
    const llm = LLMSchema.parse({
      profiles: { mine: completeCustom },
      callSites: {
        conversationSummarization: {
          profile: "mine",
          maxTokens: 1234,
          thinking: { enabled: true },
        },
      },
      ...anthropicDp,
    });
    const resolved = resolveCallSiteConfig("conversationSummarization", llm);
    expect(resolved.model).toBe("gpt-5.5");
    expect(resolved.maxTokens).toBe(1234);
    // Tweak's nested leaf merges into the winner's thinking without wiping
    // siblings.
    expect(resolved.thinking.enabled).toBe(true);
    expect(resolved.thinking.streamThinking).toBe(false);
    // Fields nobody set fall to the code-owned schema defaults.
    expect(resolved.verbosity).toBe(schemaBase.verbosity);
  });

  test("winner sampling applies; tweak sampling overrides; tweak logitBias is ignored", () => {
    const llm = LLMSchema.parse({
      profiles: { mine: { ...completeCustom, logitBias: "suppress-cjk" } },
      callSites: {
        conversationSummarization: {
          profile: "mine",
          temperature: 0.9,
          logitBias: "suppress-cjk",
        },
      },
      ...anthropicDp,
    });
    const withTweak = resolveCallSiteConfig("conversationSummarization", llm);
    expect(withTweak.temperature).toBe(0.9);
    expect(withTweak.logitBias).toBe("suppress-cjk"); // from the winner

    const noBias = LLMSchema.parse({
      profiles: { mine: completeCustom },
      callSites: {
        conversationSummarization: {
          profile: "mine",
          logitBias: "suppress-cjk",
        },
      },
      ...anthropicDp,
    });
    const resolved = resolveCallSiteConfig("conversationSummarization", noBias);
    expect(resolved.temperature).toBe(0.4); // winner's own
    expect(resolved.logitBias).toBeUndefined(); // tweak bias never applies
  });

  test("a direct call-site model override implies its catalog provider and drops the winner's connection", () => {
    const llm = LLMSchema.parse({
      profiles: { mine: completeCustom },
      callSites: {
        conversationSummarization: {
          profile: "mine",
          model: "claude-haiku-4-5-20251001",
        },
      },
      ...anthropicDp,
    });
    const resolved = resolveCallSiteConfig("conversationSummarization", llm);
    expect(resolved.model).toBe("claude-haiku-4-5-20251001");
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.provider_connection).toBeUndefined();
  });

  test("a model-only tweak keeps the provider-agnostic vellum connection for managed-routable implied providers", () => {
    const llm = LLMSchema.parse({
      callSites: {
        conversationSummarization: { model: "claude-haiku-4-5-20251001" },
      },
      defaultProvider: { provider: "vellum" },
    });
    const resolved = resolveCallSiteConfig("conversationSummarization", llm);
    expect(resolved.provider).toBe("anthropic");
    // The vellum connection routes anthropic via expectedProvider; dropping
    // it would leave platform installs with no resolvable connection.
    expect(resolved.provider_connection).toBe("vellum");
  });

  test("profileless call sites anchor on balanced intent through the default provider plus their tweaks", () => {
    const llm = LLMSchema.parse(anthropicDp);
    const resolved = resolveCallSiteConfig("workflowLeaf", llm);
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.provider_connection).toBe("anthropic-personal");
    expect(resolved.effort).toBe("low");
    expect(resolved.thinking.enabled).toBe(false);
    expect(resolveDefaultProfileKey("workflowLeaf", llm)).toBeUndefined();
  });
});

describe("mix profiles", () => {
  const mixLlm = () =>
    LLMSchema.parse({
      profiles: {
        a: { ...completeCustom, model: "gpt-5.5" },
        b: { ...completeCustom, model: "gpt-5.4" },
        ab: {
          source: "user",
          mix: [
            { profile: "a", weight: 1 },
            { profile: "b", weight: 1 },
          ],
        },
      },
      ...anthropicDp,
    });

  test("a mix expands to a seeded arm and the same seed always picks the same arm", () => {
    const llm = mixLlm();
    const first = resolveCallSiteConfig("mainAgent", llm, {
      overrideProfile: "ab",
      selectionSeed: "conversation-1",
    });
    for (let i = 0; i < 5; i++) {
      const again = resolveCallSiteConfig("mainAgent", llm, {
        overrideProfile: "ab",
        selectionSeed: "conversation-1",
      });
      expect(again.model).toBe(first.model);
    }
    expect(["gpt-5.5", "gpt-5.4"]).toContain(first.model);
  });

  test("selectWinningProfile reports the mix's own name as the winner", () => {
    const llm = mixLlm();
    const selection = selectWinningProfile("mainAgent", llm, {
      overrideProfile: "ab",
      selectionSeed: "conversation-1",
    });
    expect(selection.profileName).toBe("ab");
    expect(selection.source).toBe("override");
    expect(["gpt-5.5", "gpt-5.4"]).toContain(selection.entry?.model as string);
  });
});

describe("resolveDefaultProfileKey", () => {
  test("mainAgent: activeProfile, else the call-site intent", () => {
    const withActive = LLMSchema.parse({
      profiles: { mine: completeCustom },
      activeProfile: "mine",
      ...anthropicDp,
    });
    expect(resolveDefaultProfileKey("mainAgent", withActive)).toBe("mine");
    const without = LLMSchema.parse(anthropicDp);
    expect(resolveDefaultProfileKey("mainAgent", without)).toBe("balanced");
    expect(resolveDefaultProfileKey("conversationSummarization", without)).toBe(
      "cost-optimized",
    );
  });

  test("an incomplete activeProfile is skipped, not returned", () => {
    const llm = LLMSchema.parse({
      profiles: { partial: { source: "user", model: "gpt-5.5" } },
      activeProfile: "partial",
      ...anthropicDp,
    });
    expect(resolveDefaultProfileKey("mainAgent", llm)).toBe("balanced");
  });
});

describe("explicit default-profile references resolve through the default provider", () => {
  // Regressed failure mode: the vellum column's model ids dispatched to
  // BYOK connections.
  const managedStubs = {
    balanced: { source: "managed" as const },
    "cost-optimized": { source: "managed" as const },
  };

  test("an override pin to a default key matches the intent-rung resolution", () => {
    const llm = LLMSchema.parse({ profiles: managedStubs, ...anthropicDp });
    const pinned = resolveCallSiteConfig("mainAgent", llm, {
      overrideProfile: "cost-optimized",
    });
    // conversationSummarization's call-site default is the same intent.
    const viaIntent = resolveCallSiteConfig("conversationSummarization", llm);
    expect(pinned.provider).toBe("anthropic");
    expect(pinned.model).toBe(viaIntent.model);
    expect(pinned.provider_connection).toBe(viaIntent.provider_connection);
    expect(pinned.model).not.toBe(
      CODE_DEFAULT_PROFILE_ENTRIES["cost-optimized"].model as string,
    );
  });

  test("activeProfile set to a default key resolves the default provider's column", () => {
    const llm = LLMSchema.parse({
      profiles: managedStubs,
      activeProfile: "balanced",
      ...anthropicDp,
    });
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.provider_connection).toBe("anthropic-personal");
    expect(resolved.model).not.toBe(
      CODE_DEFAULT_PROFILE_ENTRIES.balanced.model as string,
    );
  });

  test("a vellum default provider keeps the vellum bodies", () => {
    const llm = LLMSchema.parse({
      profiles: managedStubs,
      defaultProvider: { provider: "vellum" },
    });
    const pinned = resolveCallSiteConfig("mainAgent", llm, {
      overrideProfile: "cost-optimized",
    });
    const vellumBody = CODE_DEFAULT_PROFILE_ENTRIES["cost-optimized"];
    expect(pinned.model).toBe(vellumBody.model as string);
    expect(pinned.provider_connection).toBe(vellumBody.provider_connection);
  });

  test("a mix arm naming a default key expands through the default provider", () => {
    const llm = LLMSchema.parse({
      profiles: {
        ...managedStubs,
        blend: {
          source: "user" as const,
          mix: [
            { profile: "cost-optimized", weight: 1 },
            { profile: "cost-optimized", weight: 1 },
          ],
        },
      },
      ...anthropicDp,
    });
    const resolved = resolveCallSiteConfig("mainAgent", llm, {
      overrideProfile: "blend",
      selectionSeed: "seed",
    });
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.model).not.toBe(
      CODE_DEFAULT_PROFILE_ENTRIES["cost-optimized"].model as string,
    );
  });
});

describe("hatch-era disabled stubs on default keys", () => {
  // Fresh BYOK hatches persist disabled managed stubs.
  const disabledStubs = {
    balanced: { source: "managed" as const, status: "disabled" as const },
    "cost-optimized": {
      source: "managed" as const,
      status: "disabled" as const,
    },
  };

  test("an override pin to a disabled default stub still resolves the provider's column", () => {
    const llm = LLMSchema.parse({ profiles: disabledStubs, ...anthropicDp });
    const pinned = resolveCallSiteConfig("mainAgent", llm, {
      overrideProfile: "cost-optimized",
    });
    const viaIntent = resolveCallSiteConfig("conversationSummarization", llm);
    expect(pinned.provider).toBe("anthropic");
    expect(pinned.model).toBe(viaIntent.model);
  });

  test("activeProfile pointing at a disabled default stub resolves, not falls through", () => {
    const llm = LLMSchema.parse({
      profiles: { ...disabledStubs, mine: completeCustom },
      activeProfile: "balanced",
      callSites: { mainAgent: { profile: "mine" } },
      ...anthropicDp,
    });
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    // The call-site pin below the active rung must not capture the turn.
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.model).not.toBe(completeCustom.model);
  });

  test("a disabled CUSTOM profile is still skipped", () => {
    const { fallbacks, opts } = collect();
    const llm = LLMSchema.parse({
      profiles: {
        mine: { ...completeCustom, status: "disabled" as const },
      },
      ...anthropicDp,
    });
    const resolved = resolveCallSiteConfig("mainAgent", llm, {
      ...opts,
      overrideProfile: "mine",
    });
    expect(resolved.model).not.toBe(completeCustom.model);
    expect(fallbacks).toContainEqual({
      callSite: "mainAgent",
      requested: "mine",
      reason: "disabled",
    });
  });
});

describe("user shadows of default keys keep their intent", () => {
  test("a disabled user shadow reports and falls through, not silently the catalog", () => {
    const { fallbacks, opts } = collect();
    const llm = LLMSchema.parse({
      profiles: {
        balanced: {
          ...completeCustom,
          status: "disabled" as const,
          model: "gpt-5.4",
        },
      },
      activeProfile: "balanced",
      ...anthropicDp,
    });
    const resolved = resolveCallSiteConfig("mainAgent", llm, opts);
    expect(fallbacks).toContainEqual({
      callSite: "mainAgent",
      requested: "balanced",
      reason: "disabled",
    });
    // The anchor lands on the same intent either way; the report above is
    // what distinguishes fall-through from silent replacement.
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.model).not.toBe("gpt-5.4");
  });

  test("a usable user shadow of a default key wins verbatim", () => {
    const llm = LLMSchema.parse({
      profiles: { balanced: { ...completeCustom, model: "gpt-5.4" } },
      ...anthropicDp,
    });
    const pinned = resolveCallSiteConfig("mainAgent", llm, {
      overrideProfile: "balanced",
    });
    expect(pinned.model).toBe("gpt-5.4");
    expect(pinned.provider).toBe("openai");
  });
});
