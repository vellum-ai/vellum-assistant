import { describe, expect, test } from "bun:test";

import {
  selectSeedProfileForOverride,
  type ProfilePickerEntry,
} from "@/assistant/profile-pickers";

describe("selectSeedProfileForOverride", () => {
  const profiles: ProfilePickerEntry[] = [
    { name: "balanced", label: "Balanced" },
    { name: "quality", label: "Quality" },
    { name: "speed", label: "Speed", status: "disabled" },
  ];

  test("uses the first active profile as the fallback seed", () => {
    expect(selectSeedProfileForOverride(profiles, undefined)).toBe("balanced");
  });

  test("honors an active preferred seed", () => {
    expect(selectSeedProfileForOverride(profiles, "quality")).toBe("quality");
  });

  test("falls back when the preferred seed is disabled", () => {
    expect(selectSeedProfileForOverride(profiles, "speed")).toBe("balanced");
  });
});
