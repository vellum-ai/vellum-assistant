import { describe, expect, test } from "bun:test";

import { supportsSightSessions } from "./sight-sessions";

describe("supportsSightSessions", () => {
  test("requires an explicit capability from the connected session", () => {
    expect(supportsSightSessions({ sightSessions: true })).toBe(true);
    expect(supportsSightSessions({ sightSessions: false })).toBe(false);
    expect(supportsSightSessions({})).toBe(false);
  });
});
