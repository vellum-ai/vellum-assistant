import { describe, expect, test } from "bun:test";

import {
  buildHeuristicSuggestion,
  extractSuggestibleAssistantText,
  sanitizeSuggestion,
  shouldShowSuggestion,
  type SuggestionMessage,
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

  test("truncates to default maxLen (200)", () => {
    const long = "a".repeat(300);
    const result = sanitizeSuggestion(long);
    expect(result).toHaveLength(200);
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
// extractSuggestibleAssistantText
// ---------------------------------------------------------------------------

describe("extractSuggestibleAssistantText", () => {
  test("returns text from assistant message", () => {
    const msg: SuggestionMessage = { role: "assistant", content: "Hello there!" };
    expect(extractSuggestibleAssistantText(msg)).toBe("Hello there!");
  });

  test("returns null for user message", () => {
    const msg: SuggestionMessage = { role: "user", content: "Hi" };
    expect(extractSuggestibleAssistantText(msg)).toBeNull();
  });

  test("returns null for empty assistant content", () => {
    const msg: SuggestionMessage = { role: "assistant", content: "" };
    expect(extractSuggestibleAssistantText(msg)).toBeNull();
  });

  test("returns null for whitespace-only assistant content", () => {
    const msg: SuggestionMessage = { role: "assistant", content: "   \n  " };
    expect(extractSuggestibleAssistantText(msg)).toBeNull();
  });

  test("returns text even when toolCalls are present", () => {
    const msg: SuggestionMessage = {
      role: "assistant",
      content: "Here's the result",
      toolCalls: [{ name: "search", input: { q: "test" } }],
    };
    expect(extractSuggestibleAssistantText(msg)).toBe("Here's the result");
  });

  test("returns null for tool-only message (no text)", () => {
    const msg: SuggestionMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{ name: "search", input: { q: "test" } }],
    };
    expect(extractSuggestibleAssistantText(msg)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildHeuristicSuggestion
// ---------------------------------------------------------------------------

describe("buildHeuristicSuggestion", () => {
  test('returns "Yes" when assistant text ends with a question mark', () => {
    expect(buildHeuristicSuggestion("Would you like to continue?")).toBe("Yes");
  });

  test("detects question mark followed by trailing punctuation/quotes", () => {
    expect(buildHeuristicSuggestion('Is this correct?"')).toBe("Yes");
    expect(buildHeuristicSuggestion("Ready to go?)")).toBe("Yes");
    expect(buildHeuristicSuggestion("Want to proceed?`")).toBe("Yes");
  });

  test('returns "Tell me more" for non-question text', () => {
    expect(buildHeuristicSuggestion("I've completed the task.")).toBe("Tell me more");
  });

  test('returns "Tell me more" for statements', () => {
    expect(buildHeuristicSuggestion("Here is the result")).toBe("Tell me more");
  });

  test("returns null for empty text", () => {
    expect(buildHeuristicSuggestion("")).toBeNull();
  });

  test("returns null for whitespace-only text", () => {
    expect(buildHeuristicSuggestion("   ")).toBeNull();
  });

  test("handles multiline text — checks last line for question", () => {
    const text = "Here is some info.\nDo you want more details?";
    expect(buildHeuristicSuggestion(text)).toBe("Yes");
  });

  test("handles multiline text — last line is not a question", () => {
    const text = "Do you want details?\nHere they are.";
    expect(buildHeuristicSuggestion(text)).toBe("Tell me more");
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
