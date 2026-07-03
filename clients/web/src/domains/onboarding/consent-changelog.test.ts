import { describe, expect, test } from "bun:test";

import { PRIVACY_CONSENT_VERSION } from "@/utils/onboarding-cleanup";
import {
  privacyChangeNotes,
  tosChangeNotes,
} from "@/domains/onboarding/consent-changelog";

describe("consent-changelog", () => {
  test("the current privacy version has change notes", () => {
    const notes = privacyChangeNotes(PRIVACY_CONSENT_VERSION);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes).toContain("Introduces Together AI as a new managed model provider");
  });

  test("an unknown version yields no notes", () => {
    expect(privacyChangeNotes("1999-01-01")).toEqual([]);
    expect(tosChangeNotes("1999-01-01")).toEqual([]);
  });
});
