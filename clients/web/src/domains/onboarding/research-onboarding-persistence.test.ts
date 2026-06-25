/**
 * Tests for the research-onboarding resume persistence: the round-trip
 * read/write/clear contract (user-scoped key, privacy-mode tolerance) and the
 * resolveResumeStep routing — jump to suggestions once research finished, never
 * replay the one-shot meeting confirmation, otherwise resume where we were.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  clearResearchSnapshot,
  readResearchSnapshot,
  resolveResumeStep,
  writeResearchSnapshot,
  type ResearchOnboardingSnapshot,
} from "@/domains/onboarding/research-onboarding-persistence";

const USER = "user-123";

function baseSnapshot(
  overrides: Partial<ResearchOnboardingSnapshot> = {},
): ResearchOnboardingSnapshot {
  return {
    step: "looking",
    formValues: {
      firstName: "Ada",
      lastName: "Lovelace",
      role: "Engineer",
      hobbies: ["chess"],
    },
    faceValues: null,
    checkinTime: null,
    research: null,
    ...overrides,
  };
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  sessionStorage.clear();
});

describe("read/write/clear round-trip", () => {
  test("writes then reads back the same snapshot", () => {
    const snapshot = baseSnapshot({ checkinTime: "2:30 PM" });
    writeResearchSnapshot(USER, snapshot);
    expect(readResearchSnapshot(USER)).toEqual(snapshot);
  });

  test("returns null when nothing was written", () => {
    expect(readResearchSnapshot(USER)).toBeNull();
  });

  test("is user-scoped — another user can't read this user's snapshot", () => {
    writeResearchSnapshot(USER, baseSnapshot());
    expect(readResearchSnapshot("someone-else")).toBeNull();
  });

  test("clear removes the snapshot", () => {
    writeResearchSnapshot(USER, baseSnapshot());
    clearResearchSnapshot(USER);
    expect(readResearchSnapshot(USER)).toBeNull();
  });

  test("a null user id is a no-op for read/write/clear (never throws)", () => {
    expect(() => writeResearchSnapshot(null, baseSnapshot())).not.toThrow();
    expect(readResearchSnapshot(null)).toBeNull();
    expect(() => clearResearchSnapshot(null)).not.toThrow();
  });

  test("malformed stored JSON reads as null rather than throwing", () => {
    sessionStorage.setItem(`research_onboarding:${USER}`, "{not json");
    expect(readResearchSnapshot(USER)).toBeNull();
  });
});

describe("resolveResumeStep", () => {
  test("jumps straight to suggestions once research finished", () => {
    const snapshot = baseSnapshot({
      step: "results",
      research: {
        status: "done",
        claims: [],
        suggestions: [],
        installedPlugins: [],
      },
    });
    expect(resolveResumeStep(snapshot)).toBe("suggestions");
  });

  test("never replays the one-shot meeting confirmation — resumes on looking", () => {
    expect(resolveResumeStep(baseSnapshot({ step: "meeting" }))).toBe("looking");
  });

  test("resumes the saved step mid-flow when research hasn't settled", () => {
    expect(resolveResumeStep(baseSnapshot({ step: "intro" }))).toBe("intro");
    expect(resolveResumeStep(baseSnapshot({ step: "letschat" }))).toBe(
      "letschat",
    );
  });
});
