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
      balanced: { label: "Balanced" },
      "quality-optimized": { label: "Quality" },
    };
    mockProfileOrder = ["balanced", "quality-optimized"];

    const result = getModelProfiles();
    expect(result.map((p) => p.key)).toEqual(["balanced", "quality-optimized"]);
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
      "mix-profile": {
        label: "Mix",
        mix: [{ profile: "balanced", weight: 1 }],
      },
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
    expect(result.find((p) => p.key === "quality-optimized")?.isActive).toBe(
      false,
    );
  });
});
