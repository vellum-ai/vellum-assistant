import { describe, expect, it } from "bun:test";

import { PERSONALITY_GROUPS, sampleSuggestionNames } from "@/lib/onboarding/prechat-names.js";

describe("PERSONALITY_GROUPS", () => {
  it("has 4 groups", () => {
    expect(PERSONALITY_GROUPS.length).toBe(4);
  });

  it("each group has at least 4 names", () => {
    for (const group of PERSONALITY_GROUPS) {
      expect(group.names.length).toBeGreaterThanOrEqual(4);
    }
  });
});

describe("sampleSuggestionNames", () => {
  it("returns exactly 6 names", () => {
    expect(sampleSuggestionNames().length).toBe(6);
  });

  it("returns unique names within a single call", () => {
    const sample = sampleSuggestionNames();
    expect(new Set(sample).size).toBe(sample.length);
  });

  it("returns names that all exist in a personality group", () => {
    const allNames = new Set(PERSONALITY_GROUPS.flatMap((g) => g.names));
    for (const name of sampleSuggestionNames()) {
      expect(allNames.has(name)).toBe(true);
    }
  });
});
