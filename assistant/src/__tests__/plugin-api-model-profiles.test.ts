import { beforeEach, describe, expect, test } from "bun:test";

import { getModelProfiles } from "../plugin-api/index.js";
import { setConfig } from "./helpers/set-config.js";

interface FixtureProfileEntry {
  label?: string;
  description?: string;
  provider?: string;
  model?: string;
  status?: string;
  mix?: unknown;
}

/**
 * `getModelProfiles()` — the runtime handle a plugin (e.g. a model router) calls
 * to learn which inference profiles a workspace defines. These tests pin its
 * contract: presentation ordering (`profileOrder` then alphabetical tail), mix
 * profiles included and flagged via `isMix`, disabled profiles included and
 * flagged via `isDisabled`, and the per-field fallbacks (label → key,
 * description → null, isActive → `llm.activeProfile`).
 */

function writeFixtureConfig(config: {
  llm?: {
    profiles?: Record<string, FixtureProfileEntry>;
    activeProfile?: string;
    profileOrder?: string[];
  };
}): void {
  setConfig("llm", {
    profiles: config.llm?.profiles ?? {},
    activeProfile: config.llm?.activeProfile,
    profileOrder: config.llm?.profileOrder,
  });
}

describe("getModelProfiles", () => {
  beforeEach(() => {
    writeFixtureConfig({});
  });

  test("orders profiles by profileOrder then the remaining keys alphabetically", () => {
    // GIVEN a workspace whose profileOrder names some keys, with a duplicate
    // ("balanced") and a key that resolves to no profile ("ghost").
    writeFixtureConfig({
      llm: {
        profiles: {
          zeta: { provider: "anthropic" },
          alpha: { provider: "anthropic" },
          balanced: { provider: "anthropic" },
          "cost-optimized": { provider: "anthropic" },
        },
        profileOrder: ["balanced", "cost-optimized", "balanced", "ghost"],
      },
    });
    // WHEN the profiles are listed.
    const keys = getModelProfiles().map((p) => p.key);
    // THEN profileOrder keys come first (deduped, existing-only), then the rest
    // alphabetically.
    // The catalog default not shadowed by the workspace ("quality-optimized")
    // joins the alphabetical tail.
    expect(keys).toEqual([
      "balanced",
      "cost-optimized",
      "alpha",
      "quality-optimized",
      "zeta",
    ]);
  });

  test("includes mix profiles and flags them via isMix", () => {
    // GIVEN a workspace with a weighted mix profile alongside plain ones.
    writeFixtureConfig({
      llm: {
        profiles: {
          alpha: { provider: "anthropic" },
          beta: { provider: "anthropic" },
          blend: {
            mix: [
              { profile: "alpha", weight: 1 },
              { profile: "beta", weight: 1 },
            ],
          },
        },
        profileOrder: ["alpha", "beta", "blend"],
      },
    });
    // WHEN the profiles are listed.
    const flags = getModelProfiles().map((p) => [p.key, p.isMix]);
    // THEN the mix profile is present and flagged isMix, while plain profiles are not.
    expect(flags).toEqual([
      ["alpha", false],
      ["beta", false],
      ["blend", true],
      ["balanced", false],
      ["cost-optimized", false],
      ["quality-optimized", false],
    ]);
  });

  test("marks an active mix profile via isActive", () => {
    // GIVEN a workspace whose activeProfile is itself a weighted mix.
    writeFixtureConfig({
      llm: {
        profiles: {
          alpha: { provider: "anthropic" },
          blend: {
            mix: [
              { profile: "alpha", weight: 1 },
              { profile: "beta", weight: 1 },
            ],
          },
          beta: { provider: "anthropic" },
        },
        profileOrder: ["alpha", "blend", "beta"],
        activeProfile: "blend",
      },
    });
    // WHEN the profiles are listed.
    const active = getModelProfiles()
      .filter((p) => p.isActive)
      .map((p) => p.key);
    // THEN the active mix profile is the one flagged isActive.
    expect(active).toEqual(["blend"]);
  });

  test("includes disabled profiles and flags them via isDisabled", () => {
    // GIVEN a workspace with one active and one disabled profile.
    writeFixtureConfig({
      llm: {
        profiles: {
          alpha: { provider: "anthropic", status: "active" },
          beta: { provider: "anthropic", status: "disabled" },
        },
        profileOrder: ["alpha", "beta"],
      },
    });
    // WHEN the profiles are listed.
    const flags = getModelProfiles().map((p) => [p.key, p.isDisabled]);
    // THEN the disabled profile is present and marked isDisabled.
    expect(flags).toEqual([
      ["alpha", false],
      ["beta", true],
      ["balanced", false],
      ["cost-optimized", false],
      ["quality-optimized", false],
    ]);
  });

  test("falls back to the key when a profile has no label", () => {
    // GIVEN a workspace where one profile sets a label and one does not.
    writeFixtureConfig({
      llm: {
        profiles: {
          balanced: { provider: "anthropic", label: "Balanced" },
          terse: { provider: "anthropic" },
        },
        profileOrder: ["balanced", "terse"],
      },
    });
    // WHEN the profiles are listed.
    const byKey = Object.fromEntries(
      getModelProfiles().map((p) => [p.key, p.label]),
    );
    // THEN the unlabeled profile's label falls back to its key.
    expect(byKey.balanced).toBe("Balanced");
    expect(byKey.terse).toBe("terse");
  });

  test("marks the workspace active profile via isActive", () => {
    // GIVEN a workspace whose activeProfile is "beta".
    writeFixtureConfig({
      llm: {
        profiles: {
          alpha: { provider: "anthropic" },
          beta: { provider: "anthropic" },
        },
        profileOrder: ["alpha", "beta"],
        activeProfile: "beta",
      },
    });
    // WHEN the profiles are listed.
    const flags = getModelProfiles().map((p) => [p.key, p.isActive]);
    // THEN only the active profile is marked isActive.
    expect(flags).toEqual([
      ["alpha", false],
      ["beta", true],
      ["balanced", false],
      ["cost-optimized", false],
      ["quality-optimized", false],
    ]);
  });

  test("reports description as null when a profile sets none", () => {
    // GIVEN a workspace where one profile has a description and one does not.
    writeFixtureConfig({
      llm: {
        profiles: {
          documented: {
            provider: "anthropic",
            description: "Cheaper models, slower",
          },
          bare: { provider: "anthropic" },
        },
        profileOrder: ["documented", "bare"],
      },
    });
    // WHEN the profiles are listed.
    const byKey = Object.fromEntries(
      getModelProfiles().map((p) => [p.key, p.description]),
    );
    // THEN a missing description is reported as null.
    expect(byKey.documented).toBe("Cheaper models, slower");
    expect(byKey.bare).toBeNull();
  });

  test("lists only the code-catalog defaults when the workspace defines no profiles", () => {
    // GIVEN a workspace with no profiles defined.
    writeFixtureConfig({ llm: { profiles: {}, profileOrder: [] } });
    // WHEN the profiles are listed.
    // THEN the always-available catalog defaults are the whole listing.
    expect(
      getModelProfiles()
        .map((p) => p.key)
        .sort(),
    ).toEqual(["balanced", "cost-optimized", "quality-optimized"]);
  });
});
