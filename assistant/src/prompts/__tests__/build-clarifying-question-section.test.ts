/**
 * Tests for buildClarifyingQuestionSection — verifies the system-prompt
 * nudge that points the model at `ask_question` for ambiguous requests
 * with a small number of discrete options.
 */

import { describe, expect, test } from "bun:test";

import { buildClarifyingQuestionSection } from "../system-prompt.js";

describe("buildClarifyingQuestionSection", () => {
  test("includes the Clarifying Questions heading", () => {
    const result = buildClarifyingQuestionSection();
    expect(result).toContain("## Clarifying Questions");
  });

  test("names the ask_question tool", () => {
    const result = buildClarifyingQuestionSection();
    expect(result).toContain("`ask_question`");
  });

  test("specifies the 2–4 discrete-options trigger", () => {
    const result = buildClarifyingQuestionSection();
    expect(result).toContain("2–4");
  });

  test("contains a concrete example", () => {
    const result = buildClarifyingQuestionSection();
    expect(result.toLowerCase()).toContain("example");
  });

  test("discourages over-use", () => {
    const result = buildClarifyingQuestionSection();
    // Some phrasing along the lines of "do not over-use" / "skip ... when
    // the answer is obvious from context".
    expect(result).toContain("obvious from context");
  });
});
