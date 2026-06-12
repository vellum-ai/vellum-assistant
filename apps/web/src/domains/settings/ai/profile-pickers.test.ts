import { describe, expect, test } from "bun:test";

import {
  selectSeedProfileForOverride,
  type ProfilePickerEntry,
} from "@/assistant/profile-pickers";

describe("selectSeedProfileForOverride", () => {
  const profiles: ProfilePickerEntry[] = [
    { name: "auto", label: "Auto" },
    { name: "balanced", label: "Balanced" },
    { name: "quality", label: "Quality" },
  ];

  test("skips auto as the fallback seed when query complexity routing is disabled", () => {
    expect(selectSeedProfileForOverride(profiles, undefined, false)).toBe(
      "balanced",
    );
  });

  test("does not honor auto as a preferred seed when query complexity routing is disabled", () => {
    expect(selectSeedProfileForOverride(profiles, "auto", false)).toBe(
      "balanced",
    );
  });

  test("honors auto as a preferred seed when query complexity routing is enabled", () => {
    expect(selectSeedProfileForOverride(profiles, "auto", true)).toBe("auto");
  });
});
