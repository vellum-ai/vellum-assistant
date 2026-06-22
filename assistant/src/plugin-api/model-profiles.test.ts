import { beforeEach, describe, expect, mock, test } from "bun:test";

// ─── Mock config ────────────────────────────────────────────────────────────

interface MockProfileEntry {
  label?: string;
  description?: string;
  status?: string;
  mix?: unknown;
}

let mockProfiles: Record<string, MockProfileEntry> = {};
let mockActiveProfile: string | undefined;
let mockProfileOrder: string[] | undefined;

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
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
      balanced: { label: "Balanced" },
      "quality-optimized": { label: "Quality" },
    };
    mockProfileOrder = ["balanced", "quality-optimized"];

    const result = getModelProfiles();
    expect(result.map((p) => p.key)).toEqual(["balanced", "quality-optimized"]);
  });

  test("excludes the 'auto' meta-profile", () => {
    // The daemon seeds 'auto' unconditionally into llm.profiles. It has no
    // concrete provider/model and is not a valid dispatch target for a plugin
    // sending an actual LLM call, so getModelProfiles must filter it out.
    mockProfiles = {
      auto: { label: "Auto", description: "Routes automatically" },
      balanced: { label: "Balanced" },
      "quality-optimized": { label: "Quality" },
    };
    mockProfileOrder = ["auto", "balanced", "quality-optimized"];

    const result = getModelProfiles();
    const keys = result.map((p) => p.key);
    expect(keys).not.toContain("auto");
    expect(keys).toEqual(["balanced", "quality-optimized"]);
  });

  test("excludes 'auto' even when it is the active profile", () => {
    mockProfiles = {
      auto: { label: "Auto" },
      balanced: { label: "Balanced" },
    };
    mockActiveProfile = "auto";
    mockProfileOrder = ["auto", "balanced"];

    const result = getModelProfiles();
    expect(result.map((p) => p.key)).toEqual(["balanced"]);
    // No profile should be marked active since auto was filtered
    expect(result.find((p) => p.isActive)).toBeUndefined();
  });

  test("excludes 'auto' when it is the only profile", () => {
    mockProfiles = {
      auto: { label: "Auto" },
    };

    const result = getModelProfiles();
    expect(result).toEqual([]);
  });

  test("includes disabled profiles (flagged via isDisabled)", () => {
    mockProfiles = {
      balanced: { label: "Balanced" },
      disabled: { label: "Disabled", status: "disabled" },
    };

    const result = getModelProfiles();
    expect(result).toHaveLength(2);
    const disabled = result.find((p) => p.key === "disabled");
    expect(disabled?.isDisabled).toBe(true);
  });

  test("flags mix profiles via isMix", () => {
    mockProfiles = {
      "mix-profile": { label: "Mix", mix: [{ profile: "balanced", weight: 1 }] },
    };

    const result = getModelProfiles();
    expect(result[0].isMix).toBe(true);
  });

  test("marks the active profile with isActive", () => {
    mockProfiles = {
      balanced: { label: "Balanced" },
      "quality-optimized": { label: "Quality" },
    };
    mockActiveProfile = "balanced";

    const result = getModelProfiles();
    expect(result.find((p) => p.key === "balanced")?.isActive).toBe(true);
    expect(result.find((p) => p.key === "quality-optimized")?.isActive).toBe(false);
  });
});
