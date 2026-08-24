import { describe, expect, test } from "bun:test";

import {
  ONBOARDED_HATCH_AGE_MS,
  hasOnboardedAssistant,
  isHatchedOnboarded,
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

describe("hasOnboardedAssistant", () => {
  test("is true when any assistant is past the hatch-age threshold", () => {
    expect(
      hasOnboardedAssistant(
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
      hasOnboardedAssistant(
        [
          { hatchedAt: new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString() },
          {},
        ],
        NOW,
      ),
    ).toBe(false);
    expect(hasOnboardedAssistant([], NOW)).toBe(false);
  });
});
