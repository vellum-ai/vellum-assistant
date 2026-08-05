import { describe, expect, test } from "bun:test";

import {
  isDispatchableProfile,
  profilePickerLabel,
  selectSeedProfileForOverride,
  visibleProfilesForPicker,
  type ProfilePickerEntry,
} from "@/assistant/profile-pickers";

// Config-shaped entries: `llm.profiles` values always carry a provider and
// model, or a `mix` that the daemon expands to an arm that does.
const profiles: ProfilePickerEntry[] = [
  {
    name: "balanced",
    label: "Balanced",
    provider: "anthropic",
    model: "claude-fable-5",
  },
  {
    name: "quality",
    label: "Quality",
    provider: "anthropic",
    model: "claude-opus-5",
  },
  {
    name: "off",
    label: "Off",
    status: "disabled",
    provider: "anthropic",
    model: "claude-opus-5",
  },
  // Names a provider but nothing to dispatch with. The resolver reports this
  // rung as "incomplete" and falls through to the next one.
  { name: "halfmade", label: "Half Made", provider: "anthropic" },
];

describe("isDispatchableProfile", () => {
  test("true only when enabled with a provider and a model", () => {
    expect(isDispatchableProfile(profiles[0]!)).toBe(true);
  });

  test("false when disabled, even if complete", () => {
    expect(isDispatchableProfile(profiles[2]!)).toBe(false);
  });

  test("false when either half of the pair is missing", () => {
    expect(isDispatchableProfile({ name: "a", provider: "anthropic" })).toBe(
      false,
    );
    expect(isDispatchableProfile({ name: "b", model: "claude-opus-5" })).toBe(
      false,
    );
    expect(isDispatchableProfile({ name: "c" })).toBe(false);
  });

  // A mix reports no provider or model of its own: the daemon expands it to
  // a seeded arm. Hiding mixes would remove working profiles from pickers.
  test("true for a mix despite having no provider or model", () => {
    expect(
      isDispatchableProfile({
        name: "ab",
        mix: [
          { profile: "balanced", weight: 1 },
          { profile: "quality", weight: 1 },
        ],
      }),
    ).toBe(true);
  });

  test("false for a disabled mix", () => {
    expect(
      isDispatchableProfile({
        name: "ab",
        status: "disabled",
        mix: [{ profile: "balanced", weight: 1 }],
      }),
    ).toBe(false);
  });
});

describe("selectSeedProfileForOverride", () => {
  test("uses the first dispatchable profile as the fallback seed", () => {
    expect(selectSeedProfileForOverride(profiles, undefined)).toBe("balanced");
  });

  test("honors a dispatchable preferred seed", () => {
    expect(selectSeedProfileForOverride(profiles, "quality")).toBe("quality");
  });

  test("falls back when the preferred seed is disabled", () => {
    expect(selectSeedProfileForOverride(profiles, "off")).toBe("balanced");
  });

  // Seeding an override with a profile the resolver skips would create a pin
  // that silently does nothing.
  test("falls back when the preferred seed cannot dispatch", () => {
    expect(selectSeedProfileForOverride(profiles, "halfmade")).toBe("balanced");
  });
});

describe("visibleProfilesForPicker", () => {
  test("hides profiles the resolver would skip", () => {
    const names = visibleProfilesForPicker(profiles, []).map((p) => p.name);
    expect(names).toEqual(["balanced", "quality"]);
  });

  test("keeps the current selection visible even when unusable", () => {
    // Otherwise the trigger renders an empty label and the user has no
    // recovery path from the state they are already in.
    const incomplete = visibleProfilesForPicker(profiles, ["halfmade"]).map(
      (p) => p.name,
    );
    expect(incomplete).toContain("halfmade");
    const disabled = visibleProfilesForPicker(profiles, ["off"]).map(
      (p) => p.name,
    );
    expect(disabled).toContain("off");
  });

  test("ignores null and undefined selections", () => {
    const names = visibleProfilesForPicker(profiles, [null, undefined]).map(
      (p) => p.name,
    );
    expect(names).toEqual(["balanced", "quality"]);
  });
});

describe("profilePickerLabel", () => {
  test("plain label when dispatchable", () => {
    expect(profilePickerLabel(profiles[0]!)).toBe("Balanced");
  });

  test("flags disabled", () => {
    expect(profilePickerLabel(profiles[2]!)).toBe("Off (Disabled)");
  });

  // Kept visible only as a current selection, so it has to read as broken
  // rather than as a normal choice.
  test("flags an entry that cannot dispatch", () => {
    expect(profilePickerLabel(profiles[3]!)).toBe("Half Made (Unavailable)");
  });

  test("falls back to the name when unlabeled", () => {
    expect(
      profilePickerLabel({
        name: "raw",
        provider: "anthropic",
        model: "claude-opus-5",
      }),
    ).toBe("raw");
  });
});
