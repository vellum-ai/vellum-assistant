import { describe, expect, test } from "bun:test";

import { shouldSkipOnboardingResearch } from "@/domains/onboarding/should-skip-onboarding-research";

describe("shouldSkipOnboardingResearch", () => {
  test("skips when role and hobbies are both empty", () => {
    expect(shouldSkipOnboardingResearch({ role: "", hobbies: [] })).toBe(true);
  });

  test("skips whitespace-only role and hobbies", () => {
    expect(
      shouldSkipOnboardingResearch({ role: "   ", hobbies: ["", "  "] }),
    ).toBe(true);
  });

  test("runs research when only a role is present", () => {
    expect(
      shouldSkipOnboardingResearch({ role: "Engineer", hobbies: [] }),
    ).toBe(false);
  });

  test("runs research when only hobbies are present", () => {
    expect(shouldSkipOnboardingResearch({ role: "", hobbies: ["chess"] })).toBe(
      false,
    );
  });

  test("runs research when both role and hobbies are present", () => {
    expect(
      shouldSkipOnboardingResearch({
        role: "Engineer",
        hobbies: ["chess"],
      }),
    ).toBe(false);
  });
});
