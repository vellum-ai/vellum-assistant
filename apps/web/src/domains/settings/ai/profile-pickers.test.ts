import { describe, expect, test } from "bun:test";

import {
  profilePickerLabel,
  visibleProfilesForPicker,
  type ProfilePickerEntry,
} from "@/domains/settings/ai/profile-pickers.js";

const profiles: ProfilePickerEntry[] = [
  { name: "fast", label: "Fast", status: "active" },
  { name: "balanced", label: "Balanced", status: "active" },
  { name: "deep", label: "Deep Reasoning", status: "disabled" },
  { name: "legacy", label: null, status: "disabled" },
];

describe("visibleProfilesForPicker", () => {
  test("drops disabled profiles when none are selected", () => {
    const out = visibleProfilesForPicker(profiles, []);
    expect(out.map((p) => p.name)).toEqual(["fast", "balanced"]);
  });

  test("keeps a disabled profile when it is the selected one", () => {
    const out = visibleProfilesForPicker(profiles, ["deep"]);
    expect(out.map((p) => p.name)).toEqual(["fast", "balanced", "deep"]);
  });

  test("keeps multiple disabled profiles when each is selected somewhere", () => {
    const out = visibleProfilesForPicker(profiles, ["deep", "legacy"]);
    expect(out.map((p) => p.name)).toEqual([
      "fast",
      "balanced",
      "deep",
      "legacy",
    ]);
  });

  test("ignores null/undefined entries in selectedNames", () => {
    const out = visibleProfilesForPicker(profiles, [null, undefined, "deep"]);
    expect(out.map((p) => p.name)).toEqual(["fast", "balanced", "deep"]);
  });

  test("treats absent status as active (forward-compat for older data)", () => {
    const mixed: ProfilePickerEntry[] = [
      { name: "old-active", label: "Old" },
      { name: "modern-active", label: "Modern", status: "active" },
      { name: "modern-disabled", label: "Hidden", status: "disabled" },
    ];
    const out = visibleProfilesForPicker(mixed, []);
    expect(out.map((p) => p.name)).toEqual(["old-active", "modern-active"]);
  });

  test("preserves the source ordering", () => {
    const out = visibleProfilesForPicker(profiles, ["legacy"]);
    expect(out.map((p) => p.name)).toEqual(["fast", "balanced", "legacy"]);
  });
});

describe("profilePickerLabel", () => {
  test("returns label for an active profile", () => {
    expect(profilePickerLabel({ name: "fast", label: "Fast", status: "active" })).toBe(
      "Fast",
    );
  });

  test("falls back to name when label is missing", () => {
    expect(profilePickerLabel({ name: "fast", status: "active" })).toBe("fast");
  });

  test("falls back to name when label is null", () => {
    expect(profilePickerLabel({ name: "fast", label: null, status: "active" })).toBe(
      "fast",
    );
  });

  test("appends (Disabled) suffix for disabled profiles", () => {
    expect(
      profilePickerLabel({ name: "deep", label: "Deep Reasoning", status: "disabled" }),
    ).toBe("Deep Reasoning (Disabled)");
  });

  test("uses name with (Disabled) when disabled and label is missing", () => {
    expect(profilePickerLabel({ name: "legacy", status: "disabled" })).toBe(
      "legacy (Disabled)",
    );
  });

  test("treats absent status as active (no suffix)", () => {
    expect(profilePickerLabel({ name: "fast", label: "Fast" })).toBe("Fast");
  });
});
