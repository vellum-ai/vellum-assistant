import { describe, expect, test } from "bun:test";

import { buildFallbackCopy } from "../calls/guardian-question-copy.js";

describe("buildFallbackCopy", () => {
  test("conversationTitle starts with warning emoji", () => {
    const result = buildFallbackCopy("What is the gate code?");
    expect(result.conversationTitle.startsWith("\u26A0\uFE0F")).toBe(true);
  });

  test('conversationTitle does not start with "Guardian question:"', () => {
    const result = buildFallbackCopy("What is the gate code?");
    expect(result.conversationTitle.startsWith("Guardian question:")).toBe(
      false,
    );
  });

  test("conversationTitle is under 80 characters for reasonable input", () => {
    const result = buildFallbackCopy("What is the gate code?");
    expect(result.conversationTitle.length).toBeLessThan(80);
  });

  test("initialMessage contains the question text", () => {
    const question = "Should I let the delivery driver in?";
    const result = buildFallbackCopy(question);
    expect(result.initialMessage).toContain(question);
  });

  test('initialMessage contains "Reply to this message" instruction', () => {
    const result = buildFallbackCopy("Any question here");
    expect(result.initialMessage).toContain("Reply to this message");
  });

  test("very long question text gets truncated in title", () => {
    const longQuestion = "A".repeat(200);
    const result = buildFallbackCopy(longQuestion);

    // Title should use questionText.slice(0, 70), so the question portion is at most 70 chars
    // Plus the emoji prefix and space, should still be well under 80
    expect(result.conversationTitle.length).toBeLessThanOrEqual(
      "\u26A0\uFE0F ".length + 70,
    );

    // The full question should NOT appear in the title
    expect(result.conversationTitle).not.toContain(longQuestion);

    // But the full question should still appear in the initial message
    expect(result.initialMessage).toContain(longQuestion);
  });
});
