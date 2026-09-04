import { describe, expect, test } from "bun:test";

import {
  DEFAULT_GROUP_ID,
  PERSONALITY_GROUPS,
  allAssistantNames,
  pickAssistantName,
  sampleSuggestionNames,
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
    expect(allAssistantNames()).toHaveLength(24);
    expect(new Set(allAssistantNames()).size).toBe(24);
  });
});

describe("pickAssistantName", () => {
  test("is not hardcoded to Ziggy", () => {
    expect(pickAssistantName({ random: () => 0 })).toBe("Penn");
    expect(allAssistantNames()).toContain("Ziggy");
  });

  test("can exclude the current name", () => {
    const current = pickAssistantName({ random: () => 0 });
    const next = pickAssistantName({ exclude: current, random: () => 0 });
    expect(next).not.toBe(current);
    expect(allAssistantNames()).toContain(next);
  });
});

describe("sampleSuggestionNames", () => {
  test("returns six unique names from the shared pool", () => {
    const sampled = sampleSuggestionNames(() => 0);
    expect(sampled).toHaveLength(6);
    expect(new Set(sampled).size).toBe(6);
    const pool = new Set(allAssistantNames());
    expect(sampled.every((name) => pool.has(name))).toBe(true);
  });
});
