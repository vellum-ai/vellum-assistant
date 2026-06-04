import { describe, expect, test } from "bun:test";

import {
  buildEmptyStateGreeting,
  DEFAULT_EMPTY_STATE_GREETING,
  EMPTY_STATE_PLACEHOLDERS,
  pickRandomPlaceholder,
} from "@/domains/chat/utils/empty-state-constants";

describe("EMPTY_STATE_PLACEHOLDERS", () => {
  test("contains exactly 5 entries", () => {
    expect(EMPTY_STATE_PLACEHOLDERS).toHaveLength(5);
  });

  test("contains the Fn-to-talk prompt", () => {
    expect(EMPTY_STATE_PLACEHOLDERS).toContain("Type or hold Fn to talk...");
  });
});

describe("pickRandomPlaceholder", () => {
  test("returns each placeholder when rng is forced to that index", () => {
    EMPTY_STATE_PLACEHOLDERS.forEach((expected, index) => {
      // rng must return a value in [0, 1); pick the midpoint of each slot.
      const rngValue = (index + 0.5) / EMPTY_STATE_PLACEHOLDERS.length;
      expect(pickRandomPlaceholder(() => rngValue)).toBe(expected);
    });
  });
});

describe("buildEmptyStateGreeting", () => {
  test("uses the active assistant name when available", () => {
    expect(buildEmptyStateGreeting("Douglas")).toBe("Hi, I'm Douglas!");
  });

  test("trims the assistant name before building the greeting", () => {
    expect(buildEmptyStateGreeting("  Douglas  ")).toBe("Hi, I'm Douglas!");
  });

  test("falls back when the assistant name is missing", () => {
    expect(buildEmptyStateGreeting(null)).toBe(DEFAULT_EMPTY_STATE_GREETING);
    expect(buildEmptyStateGreeting("   ")).toBe(DEFAULT_EMPTY_STATE_GREETING);
  });
});
