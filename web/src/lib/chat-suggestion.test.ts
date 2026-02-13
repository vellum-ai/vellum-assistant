import { describe, expect, test } from "bun:test";

import {
  sanitizeSuggestion,
  shouldShowSuggestion,
} from "./chat-suggestion";

// ---------------------------------------------------------------------------
// sanitizeSuggestion
// ---------------------------------------------------------------------------

describe("sanitizeSuggestion", () => {
  test("trims whitespace", () => {
    expect(sanitizeSuggestion("  hello  ")).toBe("hello");
  });

  test("returns first line only", () => {
    expect(sanitizeSuggestion("line one\nline two\nline three")).toBe("line one");
  });

  test("returns null for empty string", () => {
    expect(sanitizeSuggestion("")).toBeNull();
  });

  test("returns null for whitespace-only string", () => {
    expect(sanitizeSuggestion("   \n\n  ")).toBeNull();
  });

  test("truncates to default maxLen (50)", () => {
    const long = "a".repeat(300);
    const result = sanitizeSuggestion(long);
    expect(result).toHaveLength(50);
  });

  test("truncates to custom maxLen", () => {
    const result = sanitizeSuggestion("hello world", 5);
    expect(result).toBe("hello");
  });

  test("returns full string when under maxLen", () => {
    expect(sanitizeSuggestion("short", 200)).toBe("short");
  });

  test("handles quoted text at end of line", () => {
    expect(sanitizeSuggestion('  "hello"  ')).toBe('"hello"');
  });
});

// ---------------------------------------------------------------------------
// shouldShowSuggestion
// ---------------------------------------------------------------------------

describe("shouldShowSuggestion", () => {
  const base = {
    input: "",
    lastRole: "assistant" as const,
    isWaitingForResponse: false,
    isAlive: true,
  };

  test("returns true when all conditions met", () => {
    expect(shouldShowSuggestion(base)).toBe(true);
  });

  test("returns false when input is non-empty", () => {
    expect(shouldShowSuggestion({ ...base, input: "hello" })).toBe(false);
  });

  test("returns false when input is whitespace-only", () => {
    expect(shouldShowSuggestion({ ...base, input: "  " })).toBe(false);
  });

  test("returns false when last role is user", () => {
    expect(shouldShowSuggestion({ ...base, lastRole: "user" })).toBe(false);
  });

  test("returns false when last role is undefined", () => {
    expect(shouldShowSuggestion({ ...base, lastRole: undefined })).toBe(false);
  });

  test("returns false when waiting for response", () => {
    expect(shouldShowSuggestion({ ...base, isWaitingForResponse: true })).toBe(false);
  });

  test("returns false when assistant is not alive", () => {
    expect(shouldShowSuggestion({ ...base, isAlive: false })).toBe(false);
  });
});
