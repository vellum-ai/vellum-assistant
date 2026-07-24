import { beforeEach, describe, expect, test } from "bun:test";

import { setConfig } from "../__tests__/helpers/set-config.js";
import { getConfig } from "../config/loader.js";
import {
  getModelInputTokenPrice,
  getProfileInputTokenPrice,
} from "./profile-pricing.js";
import type { ModelProfileInfo } from "./types.js";

// ─── Fixture config ─────────────────────────────────────────────────────────

interface MockProfileEntry {
  provider?: string;
  model?: string;
  status?: string;
  mix?: Array<{ profile: string; weight: number }>;
}

interface MockDefaultProvider {
  provider: string;
  connectionName?: string;
}

let mockProfiles: Record<string, MockProfileEntry> = {};
let mockDefaultProvider: MockDefaultProvider | undefined;

// Real model catalog — the test exercises real catalog pricing lookups.

function profile(key: string): ModelProfileInfo {
  return {
    key,
    label: key,
    description: null,
    isActive: false,
    isDisabled: false,
    isMix: false,
  };
}

/**
 * Install the current fixture `llm` config for real. A schema-valid baseline is
 * seeded first so the loader caches a config object; `llm` is then overwritten
 * on that live cached object so fixtures the schema would strip (non-enum
 * provider ids) reach the resolver exactly as authored.
 */
function applyConfig(): void {
  setConfig("llm", { profiles: {} });
  const config = getConfig() as { llm: unknown };
  config.llm = {
    profiles: mockProfiles,
    ...(mockDefaultProvider != null
      ? { defaultProvider: mockDefaultProvider }
      : {}),
  };
}

function setMockConfig(
  profiles: Record<string, MockProfileEntry>,
  defaultProvider?: MockDefaultProvider,
) {
  mockProfiles = profiles;
  mockDefaultProvider = defaultProvider;
  applyConfig();
}

beforeEach(() => {
  mockProfiles = {};
  mockDefaultProvider = undefined;
  applyConfig();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("getProfileInputTokenPrice", () => {
  test("returns the catalog input-token price for a priced model", () => {
    setMockConfig({
      haiku: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      fable: { provider: "anthropic", model: "claude-fable-5" },
    });
    expect(getProfileInputTokenPrice(profile("haiku"))).toBe(1);
    expect(getProfileInputTokenPrice(profile("fable"))).toBe(10);
  });

  test("orders cheaper models below pricier ones", () => {
    setMockConfig({
      haiku: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      opus: { provider: "anthropic", model: "claude-opus-4-6" },
      fable: { provider: "anthropic", model: "claude-fable-5" },
    });
    const haiku = getProfileInputTokenPrice("haiku");
    const opus = getProfileInputTokenPrice("opus");
    const fable = getProfileInputTokenPrice("fable");
    expect(haiku).not.toBeNull();
    expect(opus).not.toBeNull();
    expect(fable).not.toBeNull();
    expect(haiku!).toBeLessThan(opus!);
    expect(opus!).toBeLessThan(fable!);
  });

  test("accepts a bare profile-key string", () => {
    setMockConfig({
      haiku: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
    });
    expect(getProfileInputTokenPrice("haiku")).toBe(1);
  });

  test("implies the provider from the catalog when profile only sets model", () => {
    setMockConfig({ "model-only": { model: "claude-haiku-4-5-20251001" } });
    expect(getProfileInputTokenPrice(profile("model-only"))).toBe(1);
  });

  test("resolves a routing-identity profile through the model's catalog owner", () => {
    setMockConfig({ managed: { provider: "vellum", model: "claude-fable-5" } });
    expect(getProfileInputTokenPrice(profile("managed"))).toBe(10);
  });

  test("returns null for an unknown provider/model pair", () => {
    setMockConfig({
      unknown: { provider: "unknown-provider", model: "unknown-model" },
    });
    expect(getProfileInputTokenPrice(profile("unknown"))).toBeNull();
  });

  test("returns null for a profile key not in config", () => {
    setMockConfig({});
    expect(getProfileInputTokenPrice(profile("nonexistent"))).toBeNull();
  });

  test("returns null for a model-less profile entry", () => {
    setMockConfig({ "provider-only": { provider: "anthropic" } });
    expect(getProfileInputTokenPrice(profile("provider-only"))).toBeNull();
  });

  test("returns null for a mix profile (no single model to price)", () => {
    setMockConfig({
      "mix-profile": {
        mix: [
          { profile: "haiku", weight: 0.5 },
          { profile: "fable", weight: 0.5 },
        ],
      },
      haiku: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      fable: { provider: "anthropic", model: "claude-fable-5" },
    });
    expect(getProfileInputTokenPrice(profile("mix-profile"))).toBeNull();
  });
});

describe("getProfileInputTokenPrice on a BYOK workspace", () => {
  // A default profile key dispatches through the `llm.defaultProvider`-aware
  // resolver, so its effective `(provider, model)` — and therefore its price —
  // comes from the default provider's column of the intent × provider matrix,
  // not the managed `vellum` body. `cost-optimized` is the sharpest case: the
  // managed body is Fireworks DeepSeek V4 Flash (0.14), the anthropic column is
  // Haiku (1), and the openai column is GPT-5.4-nano (0.2) — three distinct
  // prices for one key.
  test("prices the managed `vellum` body when no default provider is set", () => {
    setMockConfig({});
    // Fireworks DeepSeek V4 Flash — the `vellum` column of `cost-optimized`.
    expect(getProfileInputTokenPrice(profile("cost-optimized"))).toBe(0.14);
  });

  test("prices the default provider's column, not the managed body, on BYOK", () => {
    setMockConfig({}, { provider: "anthropic" });
    // Anthropic `cost-optimized` resolves to Haiku (latency-optimized intent),
    // which prices at 1 — not the managed DeepSeek body's 0.14.
    expect(getProfileInputTokenPrice(profile("cost-optimized"))).toBe(1);
  });

  test("follows the resolved provider when the default provider changes", () => {
    setMockConfig({}, { provider: "openai" });
    // OpenAI `cost-optimized` resolves to GPT-5.4-nano (0.2); `balanced`
    // resolves to GPT-5.4-mini (0.75) — both the openai column, not `vellum`.
    expect(getProfileInputTokenPrice(profile("cost-optimized"))).toBe(0.2);
    expect(getProfileInputTokenPrice(profile("balanced"))).toBe(0.75);
  });

  test("a user-owned profile is unaffected by the default provider", () => {
    // A non-default key carries its own `(provider, model)` regardless of the
    // BYOK default provider — only default-profile keys route by column.
    setMockConfig(
      { custom: { provider: "anthropic", model: "claude-fable-5" } },
      { provider: "openai" },
    );
    expect(getProfileInputTokenPrice(profile("custom"))).toBe(10);
  });
});

describe("getModelInputTokenPrice", () => {
  test("prices a concrete model id from the catalog", () => {
    expect(getModelInputTokenPrice("claude-haiku-4-5-20251001")).toBe(1);
    expect(getModelInputTokenPrice("claude-fable-5")).toBe(10);
  });

  test("ranks the vision call-site default (Haiku) below the Quality profile (Fable)", () => {
    // The image-fallback fix rests on this: on a default managed catalog the
    // only vision-capable default profile is Fable, but the vision call-site
    // default pins Haiku — which must price cheaper so it wins the ranking.
    const haiku = getModelInputTokenPrice("claude-haiku-4-5-20251001");
    const fable = getModelInputTokenPrice("claude-fable-5");
    expect(haiku).not.toBeNull();
    expect(fable).not.toBeNull();
    expect(haiku!).toBeLessThan(fable!);
  });

  test("returns null for a model the catalog does not know", () => {
    expect(getModelInputTokenPrice("nonexistent-model")).toBeNull();
  });

  test("prices a multi-provider model by the resolved provider's rate", () => {
    // `moonshotai/kimi-k2.6` is offered by two providers at different input
    // rates; the resolved provider decides which the caller is billed at.
    expect(getModelInputTokenPrice("moonshotai/kimi-k2.6", "openrouter")).toBe(
      0.6,
    );
    expect(
      getModelInputTokenPrice("moonshotai/kimi-k2.6", "vercel-ai-gateway"),
    ).toBe(0.95);
  });

  test("falls back to the first catalog provider's rate when provider is omitted", () => {
    // No provider given → the first catalog provider that offers the model
    // (openrouter) sets the rate.
    expect(getModelInputTokenPrice("moonshotai/kimi-k2.6")).toBe(0.6);
  });

  test("falls back to the model-id-only rate for a provider that does not offer the model", () => {
    // A provider the catalog doesn't offer this model under is ignored rather
    // than resolving to null.
    expect(
      getModelInputTokenPrice("moonshotai/kimi-k2.6", "no-such-provider"),
    ).toBe(0.6);
  });
});
