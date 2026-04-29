import { beforeEach, describe, expect, mock, test } from "bun:test";

let mockLlmConfig: Record<string, unknown> = {};

mock.module("../config/loader.js", () => ({
  getConfig: () => ({ llm: mockLlmConfig }),
}));

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import {
  type LLMCallSite,
  type LLMConfig,
  LLMSchema,
} from "../config/schemas/llm.js";
import {
  resolveUsageAttribution,
  sanitizeUsageMetadataValue,
} from "../usage/attribution.js";

function setLlmConfig(raw: unknown): void {
  mockLlmConfig = LLMSchema.parse(raw) as Record<string, unknown>;
}

function expectResolvedProviderModelMatchesResolver(
  callSite: LLMCallSite,
  overrideProfile?: string,
): void {
  const snapshot = resolveUsageAttribution({
    callSite,
    ...(overrideProfile != null ? { overrideProfile } : {}),
  });
  const resolved = resolveCallSiteConfig(
    callSite,
    mockLlmConfig as LLMConfig,
    {
      ...(overrideProfile != null ? { overrideProfile } : {}),
    },
  );

  expect(snapshot.resolvedProvider).toBe(resolved.provider);
  expect(snapshot.resolvedModel).toBe(resolved.model);
}

beforeEach(() => {
  mockLlmConfig = LLMSchema.parse({}) as Record<string, unknown>;
});

describe("resolveUsageAttribution", () => {
  test("resolves default-only attribution", () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
    });

    const snapshot = resolveUsageAttribution({ callSite: "mainAgent" });

    expect(snapshot).toMatchObject({
      callSite: "mainAgent",
      activeProfile: null,
      overrideProfile: null,
      callSiteProfile: null,
      appliedProfile: null,
      profileSource: "default",
      resolvedProvider: "anthropic",
      resolvedModel: "claude-opus-4-7",
    });
    expectResolvedProviderModelMatchesResolver("mainAgent");
  });

  test("resolves workspace active profile attribution", () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
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
      default: { provider: "anthropic", model: "claude-opus-4-7" },
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

  test("resolves call-site profile attribution over conversation override", () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      profiles: {
        active: { provider: "openai", model: "gpt-5.4" },
        pinned: { provider: "gemini", model: "gemini-3-pro" },
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
      overrideProfile: "pinned",
    });

    expect(snapshot).toMatchObject({
      activeProfile: "active",
      overrideProfile: "pinned",
      callSiteProfile: "site",
      appliedProfile: "site",
      profileSource: "call_site",
      resolvedProvider: "fireworks",
      resolvedModel: "accounts/fireworks/models/kimi-k2",
    });
    expectResolvedProviderModelMatchesResolver("memoryRetrieval", "pinned");
  });

  test("uses explicit call-site provider and model overrides in resolved metadata", () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
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

    expect(snapshot).toMatchObject({
      activeProfile: "active",
      callSiteProfile: null,
      appliedProfile: "active",
      profileSource: "active",
      resolvedProvider: "ollama",
      resolvedModel: "llama3.2",
    });
    expectResolvedProviderModelMatchesResolver("memoryRetrieval");
  });

  test("falls back when a runtime override profile is missing", () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
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
