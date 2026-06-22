import { describe, expect, test } from "bun:test";

import type { CallSiteOverrideDraft, ProfileEntry } from "@/generated/daemon/types.gen";
import { buildOrderedProfiles } from "@/domains/settings/ai/utils";
import {
  isDraftActive,
  draftsEqual,
} from "@/domains/settings/ai/call-site-helpers";

// ---------------------------------------------------------------------------
// isDraftActive
// ---------------------------------------------------------------------------

describe("isDraftActive", () => {
  test("returns false for null, undefined, and empty draft", () => {
    expect(isDraftActive(null)).toBe(false);
    expect(isDraftActive(undefined)).toBe(false);
    expect(isDraftActive({})).toBe(false);
  });

  test("returns true when any field is set", () => {
    expect(isDraftActive({ profile: "fast" })).toBe(true);
    expect(isDraftActive({ provider: "openai" })).toBe(true);
    expect(isDraftActive({ model: "gpt-4o" })).toBe(true);
  });

  test("returns false when all fields are null", () => {
    expect(isDraftActive({ profile: null, provider: null, model: null })).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// draftsEqual
// ---------------------------------------------------------------------------

describe("draftsEqual", () => {
  test("two inactive drafts are equal", () => {
    expect(draftsEqual(null, undefined)).toBe(true);
    expect(draftsEqual({}, null)).toBe(true);
    expect(draftsEqual({}, {})).toBe(true);
  });

  test("active vs inactive are not equal", () => {
    expect(draftsEqual({ profile: "fast" }, null)).toBe(false);
    expect(draftsEqual(null, { profile: "fast" })).toBe(false);
  });

  test("identical active drafts are equal", () => {
    const a: CallSiteOverrideDraft = {
      profile: "fast",
      provider: "openai",
      model: "gpt-4o",
    };
    expect(draftsEqual(a, { ...a })).toBe(true);
  });

  test("differing fields are detected", () => {
    const base: CallSiteOverrideDraft = {
      profile: "fast",
      provider: "openai",
      model: "gpt-4o",
    };
    expect(draftsEqual(base, { ...base, profile: "slow" })).toBe(false);
    expect(draftsEqual(base, { ...base, provider: "anthropic" })).toBe(false);
    expect(draftsEqual(base, { ...base, model: "claude-sonnet-4-20250514" })).toBe(false);
  });

  test("null and undefined fields are treated as equivalent", () => {
    expect(
      draftsEqual(
        { profile: "fast", provider: null, model: null },
        { profile: "fast", provider: undefined, model: undefined },
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildOrderedProfiles
// ---------------------------------------------------------------------------

describe("buildOrderedProfiles", () => {
  const profiles: Record<string, ProfileEntry> = {
    alpha: { label: "Alpha", status: "active" },
    beta: { label: "Beta", status: "disabled" },
    gamma: { label: "Gamma" },
  };

  test("returns profiles in profileOrder first, then extras", () => {
    const result = buildOrderedProfiles(profiles, ["beta", "alpha"]);
    expect(result.map((p) => p.name)).toEqual(["beta", "alpha", "gamma"]);
  });

  test("skips names in profileOrder that are not in profiles", () => {
    const result = buildOrderedProfiles(profiles, [
      "beta",
      "missing",
      "alpha",
    ]);
    expect(result.map((p) => p.name)).toEqual(["beta", "alpha", "gamma"]);
  });

  test("returns all profiles when profileOrder is empty", () => {
    const result = buildOrderedProfiles(profiles, []);
    expect(result.map((p) => p.name)).toEqual(["alpha", "beta", "gamma"]);
  });

  test("attaches name and spreads entry fields", () => {
    const result = buildOrderedProfiles(profiles, ["alpha"]);
    const first = result[0]!;
    expect(first.name).toBe("alpha");
    expect(first.label).toBe("Alpha");
    expect(first.status).toBe("active");
  });

  test("returns empty array when profiles is empty", () => {
    expect(buildOrderedProfiles({}, ["alpha"])).toEqual([]);
  });
});
