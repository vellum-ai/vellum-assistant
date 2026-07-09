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
    checkinBooked: false,
    research: null,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
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
    localStorage.setItem(`research_onboarding:${USER}`, "{not json");
    expect(readResearchSnapshot(USER)).toBeNull();
  });

  test("round-trips the research conversation id for mid-search resume", () => {
    const snapshot = baseSnapshot({ researchConversationId: "conv-abc" });
    writeResearchSnapshot(USER, snapshot);
    expect(readResearchSnapshot(USER)?.researchConversationId).toBe("conv-abc");
  });
});

describe("Electron host", () => {
  // The desktop app must start onboarding fresh on every launch: reads and
  // writes are no-ops, but clear stays live so completion/retire can still
  // remove a snapshot written by an older build (or the web host).
  const vellumBridge = { platform: "electron" } as unknown as Window["vellum"];

  beforeEach(() => {
    window.vellum = vellumBridge;
  });

  afterEach(() => {
    delete window.vellum;
  });

  test("never writes a snapshot", () => {
    writeResearchSnapshot(USER, baseSnapshot());
    expect(localStorage.getItem(`research_onboarding:${USER}`)).toBeNull();
  });

  test("never reads a snapshot, even one written by an older build", () => {
    localStorage.setItem(
      `research_onboarding:${USER}`,
      JSON.stringify(baseSnapshot()),
    );
    expect(readResearchSnapshot(USER)).toBeNull();
  });

  test("clear still removes a stale snapshot", () => {
    localStorage.setItem(
      `research_onboarding:${USER}`,
      JSON.stringify(baseSnapshot()),
    );
    clearResearchSnapshot(USER);
    expect(localStorage.getItem(`research_onboarding:${USER}`)).toBeNull();
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

  test("a confirmed booking resumes the meeting step on the looking carousel", () => {
    expect(
      resolveResumeStep(baseSnapshot({ step: "meeting", checkinBooked: true })),
    ).toBe("looking");
  });

  test("an unconfirmed booking resumes the meeting step back on the calendar", () => {
    // The booking POST may have been cancelled by the refresh and the endpoint
    // is non-idempotent, so fall back to the calendar step (which only books on
    // an explicit click) rather than skipping past it or blind-retrying.
    expect(
      resolveResumeStep(baseSnapshot({ step: "meeting", checkinBooked: false })),
    ).toBe("letschat");
  });

  test("resumes the saved step mid-flow when research hasn't settled", () => {
    expect(resolveResumeStep(baseSnapshot({ step: "intro" }))).toBe("intro");
    expect(resolveResumeStep(baseSnapshot({ step: "letschat" }))).toBe(
      "letschat",
    );
  });
});
