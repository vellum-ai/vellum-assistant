import { describe, expect, test } from "bun:test";

import { shouldSkipOnboardingResearch } from "@/domains/onboarding/should-skip-onboarding-research";

describe("shouldSkipOnboardingResearch", () => {
  test("skips when last name is empty, even with role and hobbies", () => {
    expect(
      shouldSkipOnboardingResearch({
        lastName: "",
        role: "Engineer",
        hobbies: ["chess"],
      }),
    ).toBe(true);
  });

  test("skips whitespace-only last name", () => {
    expect(
      shouldSkipOnboardingResearch({
        lastName: "   ",
        role: "Engineer",
        hobbies: ["chess"],
      }),
    ).toBe(true);
  });

  test("skips when role and hobbies are both empty", () => {
    expect(
      shouldSkipOnboardingResearch({
        lastName: "Example",
        role: "",
        hobbies: [],
      }),
    ).toBe(true);
  });

  test("skips whitespace-only role and hobbies", () => {
    expect(
      shouldSkipOnboardingResearch({
        lastName: "Example",
        role: "   ",
        hobbies: ["", "  "],
      }),
    ).toBe(true);
  });

  test("runs research when last name and a role are present", () => {
    expect(
      shouldSkipOnboardingResearch({
        lastName: "Example",
        role: "Engineer",
        hobbies: [],
      }),
    ).toBe(false);
  });

  test("runs research when last name and hobbies are present", () => {
    expect(
      shouldSkipOnboardingResearch({
        lastName: "Example",
        role: "",
        hobbies: ["chess"],
      }),
    ).toBe(false);
  });

  test("runs research when last name, role, and hobbies are present", () => {
    expect(
      shouldSkipOnboardingResearch({
        lastName: "Example",
        role: "Engineer",
        hobbies: ["chess"],
      }),
    ).toBe(false);
  });
});
