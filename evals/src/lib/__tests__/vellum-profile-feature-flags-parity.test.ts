/**
 * Parity guard — `external-plugins` must be enabled for every vellum
 * profile in `evals/profiles/`.
 *
 * Why this lives as a test rather than as a default flag in the adapter:
 * keeping the source of truth in `manifest.json` preserves the property
 * that a profile's behavior is fully readable from its on-disk artifacts
 * (`assistant species + setup + featureFlags`). A "default flags by
 * species" branch in the adapter would hide that — a reader of the
 * manifest wouldn't know the run is hatched with the gated plugin
 * surface unless they also opened `adapters/vellum.ts`.
 *
 * The cost is the obvious one: every new vellum profile has to remember
 * to declare the flag. This test is the forcing function — it scans
 * checked-in profiles directly (NOT a tmpdir mock) so adding
 * `profiles/vellum-foo/manifest.json` without the flag turns CI red.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { listProfileIds, getProfilesDir } from "../catalog";
import { loadProfile } from "../profile";

describe("vellum profile feature-flag parity", () => {
  test("every checked-in profile with species=vellum enables external-plugins", async () => {
    // Use the real, non-overridden profiles directory. If a future test
    // changes process.env upstream, fail loudly rather than silently
    // scanning a tmpdir.
    expect(process.env.EVALS_PROFILES_DIR).toBeUndefined();
    expect(getProfilesDir()).toMatch(/\/evals\/profiles$/);

    const ids = await listProfileIds();
    expect(ids.length).toBeGreaterThan(0);

    const vellumProfiles: string[] = [];
    for (const id of ids) {
      const profile = await loadProfile(id);
      if (profile.manifest.species !== "vellum") continue;
      vellumProfiles.push(id);
      const enabled = profile.manifest.featureFlags?.["external-plugins"];
      expect(
        enabled,
        `profile "${id}" (species: vellum) must declare featureFlags["external-plugins"] = true. ` +
          `See PR #32773 follow-up: external-plugins is required for all vellum profiles ` +
          `to keep gated-surface eval behavior consistent across the matrix.`,
      ).toBe(true);
    }

    // Pin the minimum — sanity check that the scan actually iterated.
    // If profile renames or directory layout changes drop us to zero
    // hits, the toBeGreaterThan above would still pass (0 vellum
    // profiles trivially satisfies the invariant); this anchors at
    // ≥ 2 so the guard remains meaningful.
    expect(vellumProfiles.length).toBeGreaterThanOrEqual(2);
  });

  test("vellum-bare manifest declares external-plugins on disk (smoke against the JSON)", async () => {
    // Belt-and-suspenders: read the JSON directly to catch a regression
    // where loadProfile() silently drops the field via a schema change.
    // If the field disappears at the parser level, the scan test above
    // still fails — but this one points the finger at the manifest
    // rather than the loader, which speeds diagnosis.
    const raw = await readFile(
      join(getProfilesDir(), "vellum-bare", "manifest.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as {
      featureFlags?: Record<string, boolean>;
    };
    expect(parsed.featureFlags?.["external-plugins"]).toBe(true);
  });
});
