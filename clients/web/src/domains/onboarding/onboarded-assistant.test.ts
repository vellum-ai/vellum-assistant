import { describe, expect, test } from "bun:test";

import {
  ONBOARDED_HATCH_AGE_MS,
  isAssistantOnboarded,
  isHatchedOnboarded,
  isSelectedAssistantOnboarded,
  userHasOnboardedAssistant,
} from "@/domains/onboarding/onboarded-assistant";

const NOW = Date.parse("2026-08-21T12:00:00.000Z");

describe("isHatchedOnboarded", () => {
  test("treats a hatch at least a week old as onboarded", () => {
    expect(
      isHatchedOnboarded(
        new Date(NOW - ONBOARDED_HATCH_AGE_MS).toISOString(),
        NOW,
      ),
    ).toBe(true);
    expect(
      isHatchedOnboarded(
        new Date(NOW - ONBOARDED_HATCH_AGE_MS - 1).toISOString(),
        NOW,
      ),
    ).toBe(true);
  });

  test("treats a younger hatch as not yet onboarded", () => {
    expect(
      isHatchedOnboarded(
        new Date(NOW - ONBOARDED_HATCH_AGE_MS + 1).toISOString(),
        NOW,
      ),
    ).toBe(false);
    expect(isHatchedOnboarded(new Date(NOW).toISOString(), NOW)).toBe(false);
  });

  test("ignores missing or unparseable hatch dates", () => {
    expect(isHatchedOnboarded(undefined, NOW)).toBe(false);
    expect(isHatchedOnboarded("", NOW)).toBe(false);
    expect(isHatchedOnboarded("not-a-date", NOW)).toBe(false);
  });
});

describe("userHasOnboardedAssistant", () => {
  test("is true when any assistant is past the hatch-age threshold", () => {
    expect(
      userHasOnboardedAssistant(
        [
          { hatchedAt: new Date(NOW).toISOString() },
          {
            hatchedAt: new Date(NOW - ONBOARDED_HATCH_AGE_MS).toISOString(),
          },
        ],
        NOW,
      ),
    ).toBe(true);
  });

  test("is false when every assistant is fresh or undated", () => {
    expect(
      userHasOnboardedAssistant(
        [
          { hatchedAt: new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString() },
          {},
        ],
        NOW,
      ),
    ).toBe(false);
    expect(userHasOnboardedAssistant([], NOW)).toBe(false);
  });
});

const FRESH = new Date(NOW).toISOString();
const WEEK_OLD = new Date(NOW - ONBOARDED_HATCH_AGE_MS).toISOString();

describe("isAssistantOnboarded", () => {
  test("a stamped assistant is onboarded however fresh its hatch", () => {
    expect(
      isAssistantOnboarded({ hatchedAt: FRESH, onboardedAt: FRESH }, NOW),
    ).toBe(true);
  });

  test("falls back to hatch age when unstamped", () => {
    expect(isAssistantOnboarded({ hatchedAt: WEEK_OLD }, NOW)).toBe(true);
    expect(isAssistantOnboarded({ hatchedAt: FRESH }, NOW)).toBe(false);
    expect(isAssistantOnboarded({}, NOW)).toBe(false);
  });
});

describe("isSelectedAssistantOnboarded", () => {
  const assistants = [
    { id: "old", hatchedAt: WEEK_OLD },
    { id: "new", hatchedAt: FRESH },
    { id: "stamped", hatchedAt: FRESH, onboardedAt: FRESH },
  ];

  test("answers for the selected assistant, not the list", () => {
    expect(isSelectedAssistantOnboarded(assistants, "old", NOW)).toBe(true);
    expect(isSelectedAssistantOnboarded(assistants, "stamped", NOW)).toBe(true);
    // The bug this split exists for: a week-old sibling must not answer here.
    expect(isSelectedAssistantOnboarded(assistants, "new", NOW)).toBe(false);
  });

  test("is false when nothing is selected or the id is unknown", () => {
    expect(isSelectedAssistantOnboarded(assistants, null, NOW)).toBe(false);
    expect(isSelectedAssistantOnboarded(assistants, "missing", NOW)).toBe(false);
  });
});
