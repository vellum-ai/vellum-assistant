import { beforeEach, describe, expect, test } from "bun:test";

import { setConfig } from "../__tests__/helpers/set-config.js";
import { getConfig } from "../config/loader.js";

// ─── Fixture state ──────────────────────────────────────────────────────────

interface MockProfileEntry {
  label?: string;
  description?: string;
  provider?: string;
  model?: string;
  status?: string;
  mix?: unknown;
}

let mockProfiles: Record<string, MockProfileEntry> = {};
let mockActiveProfile: string | undefined;
let mockProfileOrder: string[] | undefined;
let mockDefaultProvider: { provider: string } | undefined;

const { getModelProfiles } = await import("./model-profiles.js");

/**
 * Seed the fixture profiles for real, then list them. A schema-valid baseline
 * is seeded first so the loader caches a config object; `llm` is then
 * overwritten on that live cached object so fixtures the schema would strip
 * (single-arm mix profiles, metadata-only entries) reach getModelProfiles
 * exactly as authored.
 */
function listProfiles(): ReturnType<typeof getModelProfiles> {
  setConfig("llm", { profiles: {} });
  const config = getConfig() as { llm: unknown };
  config.llm = {
    profiles: mockProfiles,
    activeProfile: mockActiveProfile,
    profileOrder: mockProfileOrder,
    defaultProvider: mockDefaultProvider,
  };
  return getModelProfiles();
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockProfiles = {};
  mockActiveProfile = undefined;
  mockProfileOrder = undefined;
  mockDefaultProvider = undefined;
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("getModelProfiles", () => {
  test("returns all configured profiles in order", () => {
    mockProfiles = {
      balanced: { label: "Balanced", provider: "anthropic" },
      "quality-optimized": { label: "Quality", provider: "anthropic" },
    };
    mockProfileOrder = ["balanced", "quality-optimized"];

    const result = listProfiles();
    // The code-catalog defaults are always present; the two workspace
    // entries shadow their catalog counterparts, and the remaining catalog
    // default sorts after the explicit order.
    expect(result.map((p) => p.key)).toEqual([
      "balanced",
      "quality-optimized",
      "cost-optimized",
      "latency-optimized",
    ]);
  });

  test("includes disabled profiles (flagged via isDisabled)", () => {
    mockProfiles = {
      balanced: { label: "Balanced", provider: "anthropic" },
      disabled: {
        label: "Disabled",
        provider: "anthropic",
        status: "disabled",
      },
    };

    const result = listProfiles();
    expect(result.map((p) => p.key).sort()).toEqual([
      "balanced",
      "cost-optimized",
      "disabled",
      "latency-optimized",
      "quality-optimized",
    ]);
    const disabled = result.find((p) => p.key === "disabled");
    expect(disabled?.isDisabled).toBe(true);
  });

  test("flags mix profiles via isMix", () => {
    mockProfiles = {
      "mix-profile": {
        label: "Mix",
        mix: [{ profile: "balanced", weight: 1 }],
      },
    };

    const result = listProfiles();
    expect(result.find((p) => p.key === "mix-profile")?.isMix).toBe(true);
  });

  test("skips metadata-only profiles that cannot route plugin calls", () => {
    mockProfiles = {
      metadata: { label: "Metadata Only" },
      "model-only": { label: "Model Only", model: "claude-opus-4-6" },
      "provider-only": { label: "Provider Only", provider: "anthropic" },
      mix: {
        label: "Mix",
        mix: [{ profile: "model-only", weight: 1 }],
      },
    };
    mockProfileOrder = ["metadata", "model-only", "provider-only", "mix"];

    const result = listProfiles();
    expect(result.map((p) => p.key)).toEqual([
      "model-only",
      "provider-only",
      "mix",
      "balanced",
      "cost-optimized",
      "latency-optimized",
      "quality-optimized",
    ]);
  });

  test("lists the code-catalog defaults when the workspace has no profiles", () => {
    const result = listProfiles();
    expect(result.map((p) => p.key).sort()).toEqual([
      "balanced",
      "cost-optimized",
      "latency-optimized",
      "quality-optimized",
    ]);
    for (const profile of result) {
      expect(profile.isDisabled).toBe(false);
      expect(profile.isMix).toBe(false);
    }
  });

  test("default profile descriptions follow the default provider's column", () => {
    // The BYOK and vellum columns of the profile matrix carry different
    // description strings for quality-optimized and cost-optimized; the
    // listed description must come from the column that actually dispatches.
    mockDefaultProvider = { provider: "anthropic" };

    const result = listProfiles();
    expect(result.find((p) => p.key === "quality-optimized")?.description).toBe(
      "Best results with the most capable model",
    );
    expect(result.find((p) => p.key === "cost-optimized")?.description).toBe(
      "Cheapest responses, for high-volume work",
    );
  });

  test("default profile descriptions use the managed column without a default provider", () => {
    const result = listProfiles();
    expect(result.find((p) => p.key === "quality-optimized")?.description).toBe(
      "High-quality results with the most capable model",
    );
    // Tier descriptions are intent-only (no model names - LUM-2881), so the
    // managed and BYOK columns read the same for this tier.
    expect(result.find((p) => p.key === "cost-optimized")?.description).toBe(
      "Cheapest responses, for high-volume work",
    );
  });

  test("marks the active profile with isActive", () => {
    mockProfiles = {
      balanced: { label: "Balanced", provider: "anthropic" },
      "quality-optimized": { label: "Quality", provider: "anthropic" },
    };
    mockActiveProfile = "balanced";

    const result = listProfiles();
    expect(result.find((p) => p.key === "balanced")?.isActive).toBe(true);
    expect(result.find((p) => p.key === "quality-optimized")?.isActive).toBe(
      false,
    );
  });
});
