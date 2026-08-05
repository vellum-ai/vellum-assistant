import { describe, expect, test } from "bun:test";

import {
  isDispatchableProfile,
  profilePickerLabel,
  selectSeedProfileForOverride,
  visibleProfilesForPicker,
  type ProfilePickerEntry,
  profilePickerIssue,
  undispatchableProfileReason,
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

// Assistant 0.10.8 and later bake blank profile fields at write time, so a
// profile must carry its own provider and model. Older assistants deep-merge
// at resolution, so blanks live-inherit and a sparse profile dispatches.
const STRICT = { requireOwnProviderAndModel: true } as const;
const LEGACY = { requireOwnProviderAndModel: false } as const;

describe("isDispatchableProfile", () => {
  test("true only when enabled with a provider and a model", () => {
    expect(isDispatchableProfile(profiles[0]!, profiles, STRICT)).toBe(true);
  });

  test("false when disabled, even if complete", () => {
    expect(isDispatchableProfile(profiles[2]!, profiles, STRICT)).toBe(false);
  });

  test("false when either half of the pair is missing", () => {
    expect(
      isDispatchableProfile(
        { name: "a", provider: "anthropic" },
        profiles,
        STRICT,
      ),
    ).toBe(false);
    expect(
      isDispatchableProfile(
        { name: "b", model: "claude-opus-5" },
        profiles,
        STRICT,
      ),
    ).toBe(false);
    expect(isDispatchableProfile({ name: "c" }, profiles, STRICT)).toBe(false);
  });

  // A mix is expanded to ONE arm by a weighted pick seeded on the
  // conversation, so which arm runs is not knowable when the picker is
  // drawn. Offering a mix with a broken arm would dispatch on some turns
  // and silently fall through on others.
  test("true when every arm is dispatchable", () => {
    expect(
      isDispatchableProfile(
        {
          name: "ab",
          mix: [
            { profile: "balanced", weight: 1 },
            { profile: "quality", weight: 1 },
          ],
        },
        profiles,
        STRICT,
      ),
    ).toBe(true);
  });

  test("false when any arm is incomplete", () => {
    expect(
      isDispatchableProfile(
        {
          name: "ab",
          mix: [
            { profile: "balanced", weight: 1 },
            { profile: "halfmade", weight: 1 },
          ],
        },
        profiles,
        STRICT,
      ),
    ).toBe(false);
  });

  test("false when any arm is disabled", () => {
    expect(
      isDispatchableProfile(
        {
          name: "ab",
          mix: [
            { profile: "balanced", weight: 1 },
            { profile: "off", weight: 1 },
          ],
        },
        profiles,
        STRICT,
      ),
    ).toBe(false);
  });

  test("false when an arm names a profile that is not defined", () => {
    expect(
      isDispatchableProfile(
        { name: "ab", mix: [{ profile: "ghost", weight: 1 }] },
        profiles,
        STRICT,
      ),
    ).toBe(false);
  });

  test("false for an empty mix", () => {
    expect(
      isDispatchableProfile({ name: "ab", mix: [] }, profiles, STRICT),
    ).toBe(false);
  });

  test("false for a disabled mix whose arms are all fine", () => {
    expect(
      isDispatchableProfile(
        {
          name: "ab",
          status: "disabled",
          mix: [{ profile: "balanced", weight: 1 }],
        },
        profiles,
        STRICT,
      ),
    ).toBe(false);
  });
});

describe("selectSeedProfileForOverride", () => {
  test("uses the first dispatchable profile as the fallback seed", () => {
    expect(selectSeedProfileForOverride(profiles, undefined, STRICT)).toBe(
      "balanced",
    );
  });

  test("honors a dispatchable preferred seed", () => {
    expect(selectSeedProfileForOverride(profiles, "quality", STRICT)).toBe(
      "quality",
    );
  });

  test("falls back when the preferred seed is disabled", () => {
    expect(selectSeedProfileForOverride(profiles, "off", STRICT)).toBe(
      "balanced",
    );
  });

  // Seeding an override with a profile the resolver skips would create a pin
  // that silently does nothing.
  test("falls back when the preferred seed cannot dispatch", () => {
    expect(selectSeedProfileForOverride(profiles, "halfmade", STRICT)).toBe(
      "balanced",
    );
  });
});

describe("visibleProfilesForPicker", () => {
  test("hides profiles the resolver would skip", () => {
    const names = visibleProfilesForPicker(profiles, [], STRICT).map(
      (p) => p.name,
    );
    expect(names).toEqual(["balanced", "quality"]);
  });

  test("keeps the current selection visible even when unusable", () => {
    // Otherwise the trigger renders an empty label and the user has no
    // recovery path from the state they are already in.
    const incomplete = visibleProfilesForPicker(
      profiles,
      ["halfmade"],
      STRICT,
    ).map((p) => p.name);
    expect(incomplete).toContain("halfmade");
    const disabled = visibleProfilesForPicker(profiles, ["off"], STRICT).map(
      (p) => p.name,
    );
    expect(disabled).toContain("off");
  });

  test("ignores null and undefined selections", () => {
    const names = visibleProfilesForPicker(
      profiles,
      [null, undefined],
      STRICT,
    ).map((p) => p.name);
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

  // The undispatchable case is not a word in the label: surfaces render the
  // warning affordance for it, so the label stays the profile's own name.
  test("leaves an undispatchable entry's name alone", () => {
    expect(profilePickerLabel(profiles[3]!)).toBe("Half Made");
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

describe("profilePickerIssue", () => {
  test("null when the profile is a usable choice", () => {
    expect(profilePickerIssue(profiles[0]!, profiles, STRICT)).toBeNull();
  });

  // Disabled is a state the user chose, and the label already says so. The
  // undispatchable case is a misconfiguration, so surfaces flag it the way
  // the Profiles row flags an availability problem.
  test("distinguishes a chosen off state from a broken one", () => {
    expect(profilePickerIssue(profiles[2]!, profiles, STRICT)).toBe("disabled");
    expect(profilePickerIssue(profiles[3]!, profiles, STRICT)).toBe(
      "undispatchable",
    );
  });

  test("a mix with a broken arm is undispatchable, not disabled", () => {
    expect(
      profilePickerIssue(
        { name: "ab", mix: [{ profile: "halfmade", weight: 1 }] },
        profiles,
        STRICT,
      ),
    ).toBe("undispatchable");
  });
});

describe("undispatchableProfileReason", () => {
  test("names the profile and what happens instead", () => {
    const reason = undispatchableProfileReason(profiles[3]!);
    expect(reason).toContain("Half Made");
    expect(reason).toContain("falls back");
  });

  test("a mix explains that only some turns fall back", () => {
    const reason = undispatchableProfileReason({
      name: "ab",
      label: "A/B",
      mix: [{ profile: "halfmade", weight: 1 }],
    });
    expect(reason).toContain("some turns");
  });
});

describe("assistants older than complete-profile-snapshots (0.10.8)", () => {
  // Blank fields live-inherit there, so judging them by the strict rule
  // would hide a profile the resolver dispatches perfectly well.
  test("a sparse profile is dispatchable", () => {
    expect(isDispatchableProfile({ name: "sparse" }, profiles, LEGACY)).toBe(
      true,
    );
    expect(isDispatchableProfile(profiles[3]!, profiles, LEGACY)).toBe(true);
  });

  test("disabled still wins: it is a choice, not an inherited blank", () => {
    expect(isDispatchableProfile(profiles[2]!, profiles, LEGACY)).toBe(false);
  });

  // Its one arm is sparse, which dispatches on a legacy assistant, so the
  // mix does too. The same mix is undispatchable under STRICT above.
  test("a mix whose arms are sparse is dispatchable", () => {
    expect(
      isDispatchableProfile(
        { name: "ab", mix: [{ profile: "halfmade", weight: 1 }] },
        profiles,
        LEGACY,
      ),
    ).toBe(true);
  });

  test("nothing is flagged as undispatchable", () => {
    expect(profilePickerIssue(profiles[3]!, profiles, LEGACY)).toBeNull();
  });

  test("no profile is hidden from the picker", () => {
    const names = visibleProfilesForPicker(profiles, [], LEGACY).map(
      (p) => p.name,
    );
    expect(names).toEqual(["balanced", "quality", "halfmade"]);
  });
});
