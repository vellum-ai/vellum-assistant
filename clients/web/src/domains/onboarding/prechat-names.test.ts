import { describe, expect, test } from "bun:test";

import {
  DEFAULT_GROUP_ID,
  PERSONALITY_GROUPS,
  personalityGroupsFor,
} from "@/domains/onboarding/prechat-names";

describe("personality groups", () => {
  test("keep grounded, warm, energetic, and poetic", () => {
    expect(PERSONALITY_GROUPS.map((group) => group.id)).toEqual([
      "grounded",
      "warm",
      "energetic",
      "poetic",
    ]);
    expect(DEFAULT_GROUP_ID).toBe("grounded");
  });

  test("a Dutch pool still has every personality group", () => {
    const dutch = personalityGroupsFor("nl");
    expect(dutch.map((group) => group.id)).toEqual([
      "grounded",
      "warm",
      "energetic",
      "poetic",
    ]);
    expect(dutch.every((group) => group.names.length === 6)).toBe(true);
    expect(dutch[0]?.names).toContain("Bram");
    expect(dutch.flatMap((group) => group.names)).not.toContain("Ziggy");
  });
});
