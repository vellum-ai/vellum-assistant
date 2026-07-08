import { beforeEach, describe, expect, mock, test } from "bun:test";

// ─── Mock config ────────────────────────────────────────────────────────────

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

const realConfigLoader = await import("../config/loader.js");

mock.module("../config/loader.js", () => ({
  ...realConfigLoader,
  getConfig: () => ({
    llm: {
      profiles: mockProfiles,
      activeProfile: mockActiveProfile,
      profileOrder: mockProfileOrder,
    },
  }),
  getConfigReadOnly: () => ({
    llm: {
      profiles: mockProfiles,
      activeProfile: mockActiveProfile,
      profileOrder: mockProfileOrder,
    },
  }),
}));

const { getModelProfiles } = await import("./model-profiles.js");

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockProfiles = {};
  mockActiveProfile = undefined;
  mockProfileOrder = undefined;
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("getModelProfiles", () => {
  test("returns all configured profiles in order", () => {
    mockProfiles = {
      balanced: { label: "Balanced", provider: "anthropic" },
      "quality-optimized": { label: "Quality", provider: "anthropic" },
    };
    mockProfileOrder = ["balanced", "quality-optimized"];

    const result = getModelProfiles();
    // The code-catalog defaults are always present; the two workspace
    // entries shadow their catalog counterparts, and the remaining catalog
    // default sorts after the explicit order.
    expect(result.map((p) => p.key)).toEqual([
      "balanced",
      "quality-optimized",
      "cost-optimized",
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

    const result = getModelProfiles();
    expect(result.map((p) => p.key).sort()).toEqual([
      "balanced",
      "cost-optimized",
      "disabled",
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

    const result = getModelProfiles();
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

    const result = getModelProfiles();
    expect(result.map((p) => p.key)).toEqual([
      "model-only",
      "provider-only",
      "mix",
      "balanced",
      "cost-optimized",
      "quality-optimized",
    ]);
  });

  test("lists the code-catalog defaults when the workspace has no profiles", () => {
    const result = getModelProfiles();
    expect(result.map((p) => p.key).sort()).toEqual([
      "balanced",
      "cost-optimized",
      "quality-optimized",
    ]);
    for (const profile of result) {
      expect(profile.isDisabled).toBe(false);
      expect(profile.isMix).toBe(false);
    }
  });

  test("marks the active profile with isActive", () => {
    mockProfiles = {
      balanced: { label: "Balanced", provider: "anthropic" },
      "quality-optimized": { label: "Quality", provider: "anthropic" },
    };
    mockActiveProfile = "balanced";

    const result = getModelProfiles();
    expect(result.find((p) => p.key === "balanced")?.isActive).toBe(true);
    expect(result.find((p) => p.key === "quality-optimized")?.isActive).toBe(
      false,
    );
  });
});
