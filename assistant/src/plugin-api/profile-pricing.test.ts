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

let mockProfiles: Record<string, MockProfileEntry> = {};

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
  config.llm = { profiles: mockProfiles };
}

function setMockConfig(profiles: Record<string, MockProfileEntry>) {
  mockProfiles = profiles;
  applyConfig();
}

beforeEach(() => {
  mockProfiles = {};
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
});
