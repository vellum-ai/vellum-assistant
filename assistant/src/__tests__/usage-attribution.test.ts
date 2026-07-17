import { beforeEach, describe, expect, test } from "bun:test";

// The pre-existing describes pin attribution under the legacy cascade
// (flag-off); the trailing describe pins the override-or-default mapping.
import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import { type LLMCallSite } from "../config/schemas/llm.js";
import {
  resolveUsageAttribution,
  sanitizeUsageMetadataValue,
} from "../usage/attribution.js";
import { setConfig } from "./helpers/set-config.js";

/** Seed the workspace `llm` config for real; the loader schema-merges it. */
function setLlmConfig(raw: unknown): void {
  setConfig("llm", raw);
}

function expectResolvedProviderModelMatchesResolver(
  callSite: LLMCallSite,
  overrideProfile?: string,
): void {
  const snapshot = resolveUsageAttribution({
    callSite,
    ...(overrideProfile != null ? { overrideProfile } : {}),
  });
  const resolved = resolveCallSiteConfig(callSite, getConfig().llm, {
    ...(overrideProfile != null ? { overrideProfile } : {}),
  });

  expect(snapshot.resolvedProvider).toBe(resolved.provider);
  expect(snapshot.resolvedModel).toBe(resolved.model);
}

beforeEach(() => {
  setConfig("llm", {});
});

describe("resolveUsageAttribution", () => {
  test("resolves default-intent attribution with a call-site tweak", () => {
    setLlmConfig({
      callSites: {
        mainAgent: { provider: "anthropic", model: "claude-opus-4-7" },
      },
    });

    const snapshot = resolveUsageAttribution({ callSite: "mainAgent" });

    // No override/active/site profile is set, so the winner is mainAgent's
    // default intent (balanced); the call-site tweak supplies provider/model.
    expect(snapshot).toMatchObject({
      callSite: "mainAgent",
      activeProfile: null,
      overrideProfile: null,
      callSiteProfile: null,
      appliedProfile: "balanced",
      profileSource: "default",
      resolvedProvider: "anthropic",
      resolvedModel: "claude-opus-4-7",
    });
    expectResolvedProviderModelMatchesResolver("mainAgent");
  });

  test("resolves workspace active profile attribution", () => {
    setLlmConfig({
      profiles: {
        balanced: { provider: "openai", model: "gpt-5.4" },
      },
      activeProfile: "balanced",
    });

    const snapshot = resolveUsageAttribution({ callSite: "mainAgent" });

    expect(snapshot).toMatchObject({
      activeProfile: "balanced",
      overrideProfile: null,
      callSiteProfile: null,
      appliedProfile: "balanced",
      profileSource: "active",
      resolvedProvider: "openai",
      resolvedModel: "gpt-5.4",
    });
    expectResolvedProviderModelMatchesResolver("mainAgent");
  });

  test("resolves per-conversation override profile attribution", () => {
    setLlmConfig({
      profiles: {
        active: { provider: "openai", model: "gpt-5.4" },
        pinned: { provider: "gemini", model: "gemini-3-pro" },
      },
      activeProfile: "active",
    });

    const snapshot = resolveUsageAttribution({
      callSite: "mainAgent",
      overrideProfile: "pinned",
    });

    expect(snapshot).toMatchObject({
      activeProfile: "active",
      overrideProfile: "pinned",
      callSiteProfile: null,
      appliedProfile: "pinned",
      profileSource: "conversation",
      resolvedProvider: "gemini",
      resolvedModel: "gemini-3-pro",
    });
    expectResolvedProviderModelMatchesResolver("mainAgent", "pinned");
  });

  test("resolves call-site profile attribution", () => {
    setLlmConfig({
      profiles: {
        active: { provider: "openai", model: "gpt-5.4" },
        site: {
          provider: "fireworks",
          model: "accounts/fireworks/models/kimi-k2",
        },
      },
      activeProfile: "active",
      callSites: {
        memoryRetrieval: { profile: "site" },
      },
    });

    const snapshot = resolveUsageAttribution({
      callSite: "memoryRetrieval",
    });

    // activeProfile applies only to mainAgent, so the call-site pin wins here.
    expect(snapshot).toMatchObject({
      activeProfile: "active",
      overrideProfile: null,
      callSiteProfile: "site",
      appliedProfile: "site",
      profileSource: "call_site",
      resolvedProvider: "fireworks",
      resolvedModel: "accounts/fireworks/models/kimi-k2",
    });
    expectResolvedProviderModelMatchesResolver("memoryRetrieval");
  });

  test("attributes mainAgent to conversation profile over call-site profile", () => {
    setLlmConfig({
      profiles: {
        active: { provider: "openai", model: "gpt-5.4" },
        pinned: { provider: "gemini", model: "gemini-2.5-pro" },
        site: {
          provider: "fireworks",
          model: "accounts/fireworks/models/kimi-k2p5",
        },
      },
      activeProfile: "active",
      callSites: {
        mainAgent: { profile: "site" },
      },
    });

    const snapshot = resolveUsageAttribution({
      callSite: "mainAgent",
      overrideProfile: "pinned",
    });

    expect(snapshot).toMatchObject({
      activeProfile: "active",
      overrideProfile: "pinned",
      callSiteProfile: "site",
      appliedProfile: "pinned",
      profileSource: "conversation",
      resolvedProvider: "gemini",
      resolvedModel: "gemini-2.5-pro",
    });
    expectResolvedProviderModelMatchesResolver("mainAgent", "pinned");
  });

  test("uses explicit call-site provider and model overrides in resolved metadata", () => {
    setLlmConfig({
      profiles: {
        active: { provider: "openai", model: "gpt-5.4" },
      },
      activeProfile: "active",
      callSites: {
        memoryRetrieval: {
          provider: "ollama",
          model: "llama3.2",
        },
      },
    });

    const snapshot = resolveUsageAttribution({
      callSite: "memoryRetrieval",
    });

    // The winner is memoryRetrieval's default intent (activeProfile applies
    // only to mainAgent); the call-site tweak still determines the resolved
    // provider/model because it applies last.
    expect(snapshot).toMatchObject({
      activeProfile: "active",
      callSiteProfile: null,
      appliedProfile: "cost-optimized",
      profileSource: "default",
      resolvedProvider: "ollama",
      resolvedModel: "llama3.2",
    });
    expectResolvedProviderModelMatchesResolver("memoryRetrieval");
  });

  test("falls back when a runtime override profile is missing", () => {
    setLlmConfig({
      profiles: {
        active: { provider: "openai", model: "gpt-5.4" },
      },
      activeProfile: "active",
    });

    const snapshot = resolveUsageAttribution({
      callSite: "mainAgent",
      overrideProfile: "deleted",
    });

    expect(snapshot).toMatchObject({
      activeProfile: "active",
      overrideProfile: "deleted",
      appliedProfile: "active",
      profileSource: "active",
      resolvedProvider: "openai",
      resolvedModel: "gpt-5.4",
    });
    expectResolvedProviderModelMatchesResolver("mainAgent", "deleted");
  });
});

describe("sanitizeUsageMetadataValue", () => {
  test("trims, drops empty values, caps long values, and rejects controls", () => {
    expect(sanitizeUsageMetadataValue("  profile-1  ")).toBe("profile-1");
    expect(sanitizeUsageMetadataValue("   ")).toBeNull();
    expect(sanitizeUsageMetadataValue(`profile\n1`)).toBeNull();
    expect(sanitizeUsageMetadataValue("profile\u00851")).toBeNull();
    expect(sanitizeUsageMetadataValue("x".repeat(200))).toHaveLength(128);
  });
});

describe("resolveUsageAttribution — single-winner semantics", () => {
  const completeProfile = {
    source: "user",
    provider: "openai",
    provider_connection: "openai-personal",
    model: "gpt-5.5",
    maxTokens: 9000,
  };

  test("a non-forced override wins attribution on a background call site", () => {
    setLlmConfig({
      profiles: { mine: completeProfile },
      callSites: {
        conversationSummarization: { profile: "quality-optimized" },
      },
      defaultProvider: { provider: "anthropic" },
    });
    const snapshot = resolveUsageAttribution({
      callSite: "conversationSummarization",
      overrideProfile: "mine",
    });
    expect(snapshot.appliedProfile).toBe("mine");
    expect(snapshot.profileSource).toBe("conversation");
    expect(snapshot.resolvedModel).toBe("gpt-5.5");
  });

  test("the default intent attributes its profile key with source 'default'", () => {
    setLlmConfig({ defaultProvider: { provider: "anthropic" } });
    const snapshot = resolveUsageAttribution({
      callSite: "conversationSummarization",
    });
    expect(snapshot.appliedProfile).toBe("cost-optimized");
    expect(snapshot.profileSource).toBe("default");
    expect(snapshot.resolvedProvider).toBe("anthropic");
  });

  test("activeProfile attributes as 'active' on mainAgent only", () => {
    setLlmConfig({
      profiles: { mine: completeProfile },
      activeProfile: "mine",
      defaultProvider: { provider: "anthropic" },
    });
    expect(resolveUsageAttribution({ callSite: "mainAgent" })).toMatchObject({
      appliedProfile: "mine",
      profileSource: "active",
    });
    expect(
      resolveUsageAttribution({ callSite: "conversationSummarization" }),
    ).toMatchObject({
      appliedProfile: "cost-optimized",
      profileSource: "default",
    });
  });

  test("attribution provider/model agree with the resolver", () => {
    setLlmConfig({
      profiles: { mine: completeProfile },
      defaultProvider: { provider: "anthropic" },
    });
    expectResolvedProviderModelMatchesResolver("conversationSummarization");
    expectResolvedProviderModelMatchesResolver("mainAgent", "mine");
  });
});
