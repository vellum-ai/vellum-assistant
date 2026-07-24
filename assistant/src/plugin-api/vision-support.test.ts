import { beforeEach, describe, expect, test } from "bun:test";

import { setConfig } from "../__tests__/helpers/set-config.js";
import { getConfig } from "../config/loader.js";
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

// Real model catalog — don't mock it, the test exercises real catalog lookups.
const { doesSupportVision } = await import("./vision-support.js");

// ─── Helpers ────────────────────────────────────────────────────────────────

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
 * Install the current fixture `llm` config for real. A schema-valid baseline
 * is seeded first so the loader caches a config object; `llm` is then
 * overwritten on that live cached object so fixtures the schema would strip
 * (non-enum provider ids) reach the resolver exactly as authored.
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

describe("doesSupportVision", () => {
  test("returns true for a known vision-capable model", () => {
    setMockConfig({
      "vision-profile": { provider: "anthropic", model: "claude-opus-4-6" },
    });
    expect(doesSupportVision(profile("vision-profile"))).toBe(true);
  });

  test("returns false for a known text-only model", () => {
    setMockConfig({
      "text-profile": {
        provider: "fireworks",
        model: "accounts/fireworks/models/glm-5p2",
      },
    });
    expect(doesSupportVision(profile("text-profile"))).toBe(false);
  });

  test("returns false for an unknown profile key not in config", () => {
    setMockConfig({});
    expect(doesSupportVision(profile("nonexistent"))).toBe(false);
  });

  test("returns false for an unknown provider/model pair", () => {
    setMockConfig({
      "unknown-model": { provider: "unknown-provider", model: "unknown-model" },
    });
    expect(doesSupportVision(profile("unknown-model"))).toBe(false);
  });

  test("implies the provider from the catalog when profile only sets model", () => {
    setMockConfig({ "model-only": { model: "claude-opus-4-6" } });
    expect(doesSupportVision(profile("model-only"))).toBe(true);
  });

  test("resolves a routing-identity profile through the model's catalog owner", () => {
    setMockConfig({
      managed: { provider: "vellum", model: "claude-fable-5" },
      "managed-text": {
        provider: "vellum",
        model: "accounts/fireworks/models/deepseek-v4-flash",
      },
    });
    expect(doesSupportVision(profile("managed"))).toBe(true);
    expect(doesSupportVision(profile("managed-text"))).toBe(false);
  });

  test("fails safe to false for a profile without a model", () => {
    // A model-less entry is not a usable resolution target, so vision
    // resolution treats it as "can't show images" (caption instead).
    setMockConfig({ "provider-only": { provider: "anthropic" } });
    expect(doesSupportVision(profile("provider-only"))).toBe(false);
  });

  test("mix profile returns true when any arm supports vision", () => {
    setMockConfig({
      "mix-profile": {
        mix: [
          { profile: "text-arm", weight: 0.5 },
          { profile: "vision-arm", weight: 0.5 },
        ],
      },
      "text-arm": {
        provider: "fireworks",
        model: "accounts/fireworks/models/glm-5p2",
      },
      "vision-arm": { provider: "anthropic", model: "claude-opus-4-6" },
    });
    expect(doesSupportVision(profile("mix-profile"))).toBe(true);
  });

  test("mix profile returns false when all arms are text-only", () => {
    setMockConfig({
      "mix-profile": {
        mix: [
          { profile: "text-arm-1", weight: 0.5 },
          { profile: "text-arm-2", weight: 0.5 },
        ],
      },
      "text-arm-1": {
        provider: "fireworks",
        model: "accounts/fireworks/models/glm-5p2",
      },
      "text-arm-2": {
        provider: "fireworks",
        model: "accounts/fireworks/models/glm-5p2",
      },
    });
    expect(doesSupportVision(profile("mix-profile"))).toBe(false);
  });
});

describe("doesSupportVision on a BYOK workspace", () => {
  // A default profile key is capability-checked against the model dispatch runs
  // it as — the default provider's column — not the managed `vellum` body.
  // `cost-optimized` flips capability across columns: the managed body is
  // Fireworks DeepSeek V4 Flash (text-only), while the anthropic column is
  // Haiku and the openai column is GPT-5.4-nano (both vision-capable).
  test("checks the managed `vellum` body when no default provider is set", () => {
    setMockConfig({});
    // DeepSeek V4 Flash — the `vellum` column of `cost-optimized` — is
    // text-only.
    expect(doesSupportVision(profile("cost-optimized"))).toBe(false);
  });

  test("checks the default provider's column, not the managed body, on BYOK", () => {
    setMockConfig({}, { provider: "anthropic" });
    // Anthropic `cost-optimized` resolves to Haiku, which is vision-capable —
    // the opposite of the managed DeepSeek body's answer.
    expect(doesSupportVision(profile("cost-optimized"))).toBe(true);
  });

  test("follows the resolved provider when the default provider changes", () => {
    setMockConfig({}, { provider: "openai" });
    // OpenAI `cost-optimized` resolves to GPT-5.4-nano — vision-capable.
    expect(doesSupportVision(profile("cost-optimized"))).toBe(true);
  });
});

describe("doesSupportVision with a bare string", () => {
  test("returns true for a known vision-capable model id", () => {
    expect(doesSupportVision("claude-opus-4-6")).toBe(true);
  });

  test("returns false for a known text-only model id", () => {
    expect(doesSupportVision("accounts/fireworks/models/glm-5p2")).toBe(false);
  });

  test("falls back to resolving the string as a profile key", () => {
    // "vision-profile" is not a catalog model id, so it resolves as a profile
    // key → anthropic/claude-opus-4-6 (vision-capable).
    setMockConfig({
      "vision-profile": { provider: "anthropic", model: "claude-opus-4-6" },
    });
    expect(doesSupportVision("vision-profile")).toBe(true);
  });

  test("returns false for a string that is neither a model nor a profile", () => {
    setMockConfig({});
    expect(doesSupportVision("some-unknown-string")).toBe(false);
  });

  test("checks the provider-scoped catalog entry when a provider is given", () => {
    // `moonshotai/kimi-k2.6` is offered by two providers; both are
    // vision-capable, so the provider-scoped entry answers true either way.
    expect(doesSupportVision("moonshotai/kimi-k2.6", "vercel-ai-gateway")).toBe(
      true,
    );
    expect(doesSupportVision("moonshotai/kimi-k2.6", "openrouter")).toBe(true);
  });

  test("falls back to the model-id-only entry for a provider that does not offer the model", () => {
    // An unknown provider is ignored; the model-id-only catalog match decides.
    expect(doesSupportVision("moonshotai/kimi-k2.6", "no-such-provider")).toBe(
      true,
    );
  });
});
