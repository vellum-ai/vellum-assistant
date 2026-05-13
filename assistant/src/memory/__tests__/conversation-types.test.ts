import { describe, expect, test } from "bun:test";

import { isBackgroundConversationType } from "../conversation-types.js";

describe("isBackgroundConversationType", () => {
  test("returns true for background", () => {
    expect(isBackgroundConversationType("background")).toBe(true);
  });

  test("returns true for scheduled", () => {
    expect(isBackgroundConversationType("scheduled")).toBe(true);
  });

  test("returns false for standard", () => {
    expect(isBackgroundConversationType("standard")).toBe(false);
  });

  test("returns false for null", () => {
    expect(isBackgroundConversationType(null)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isBackgroundConversationType(undefined)).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isBackgroundConversationType("")).toBe(false);
  });

  test.each(["chat", "foo", "BACKGROUND", "Scheduled", " background "])(
    "returns false for unknown string %p",
    (value) => {
      expect(isBackgroundConversationType(value)).toBe(false);
    },
  );
});
