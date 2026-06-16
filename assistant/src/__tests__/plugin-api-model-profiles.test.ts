import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";

import { invalidateConfigCache } from "../config/loader.js";
import { getModelProfiles } from "../plugin-api/index.js";
import { getWorkspaceConfigPath } from "../util/platform.js";

/**
 * `getModelProfiles()` — the runtime handle a plugin (e.g. a model router) calls
 * to learn which inference profiles a workspace defines. These tests pin its
 * contract: presentation ordering (`profileOrder` then alphabetical tail), mix
 * profiles omitted, disabled profiles included and flagged, and the per-field
 * fallbacks (label → key, description → null, isActive → `llm.activeProfile`).
 */

function writeFixtureConfig(config: Record<string, unknown>): void {
  writeFileSync(getWorkspaceConfigPath(), JSON.stringify(config), "utf-8");
  invalidateConfigCache();
}

describe("getModelProfiles", () => {
  afterEach(() => {
    invalidateConfigCache();
  });

  test("orders profiles by profileOrder then the remaining keys alphabetically", () => {
    // GIVEN a workspace whose profileOrder names some keys, with a duplicate
    // ("balanced") and a key that resolves to no profile ("ghost").
    writeFixtureConfig({
      llm: {
        profiles: { zeta: {}, alpha: {}, balanced: {}, "cost-optimized": {} },
        profileOrder: ["balanced", "cost-optimized", "balanced", "ghost"],
      },
    });
    // WHEN the profiles are listed.
    const keys = getModelProfiles().map((p) => p.key);
    // THEN profileOrder keys come first (deduped, existing-only), then the rest
    // alphabetically.
    expect(keys).toEqual(["balanced", "cost-optimized", "alpha", "zeta"]);
  });

  test("omits mix profiles, which are not a routing target", () => {
    // GIVEN a workspace with a weighted mix profile alongside plain ones.
    writeFixtureConfig({
      llm: {
        profiles: {
          alpha: {},
          beta: {},
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
    const keys = getModelProfiles().map((p) => p.key);
    // THEN the mix profile is filtered out.
    expect(keys).toEqual(["alpha", "beta"]);
  });

  test("includes disabled profiles and flags them via isDisabled", () => {
    // GIVEN a workspace with one active and one disabled profile.
    writeFixtureConfig({
      llm: {
        profiles: {
          alpha: { status: "active" },
          beta: { status: "disabled" },
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
    ]);
  });

  test("falls back to the key when a profile has no label", () => {
    // GIVEN a workspace where one profile sets a label and one does not.
    writeFixtureConfig({
      llm: {
        profiles: { balanced: { label: "Balanced" }, terse: {} },
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
        profiles: { alpha: {}, beta: {} },
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
    ]);
  });

  test("reports description as null when a profile sets none", () => {
    // GIVEN a workspace where one profile has a description and one does not.
    writeFixtureConfig({
      llm: {
        profiles: {
          documented: { description: "Cheaper models, slower" },
          bare: {},
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

  test("returns an empty list when the workspace defines no profiles", () => {
    // GIVEN a workspace with no profiles defined.
    writeFixtureConfig({ llm: { profiles: {}, profileOrder: [] } });
    // WHEN the profiles are listed.
    // THEN the result is empty.
    expect(getModelProfiles()).toEqual([]);
  });
});
