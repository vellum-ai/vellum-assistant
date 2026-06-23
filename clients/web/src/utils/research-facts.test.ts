/**
 * Contract tests for the research-fact parser's plugin tagging.
 *
 * The research-onboarding flow lets the assistant tag a suggestion with the
 * marketplace plugin (`plugin`) whose skills its prompt should trigger; the
 * runner background-installs any tagged plugin. These tests pin that the
 * optional `plugin` field round-trips, stays absent for ordinary suggestions,
 * and survives the streaming-tolerant extraction unchanged.
 */

import { describe, expect, test } from "bun:test";

import { parseResearchResultStreaming } from "@/utils/research-facts";

describe("parseResearchResultStreaming — plugin tagging", () => {
  test("parses the optional plugin field on a suggestion", () => {
    const text = JSON.stringify({
      claims: [],
      suggestions: [
        {
          suggestion: "I'll sharpen your positioning and run a teardown",
          prompt: "Sharpen my positioning and run a competitive teardown",
          plugin: "marketing-expert",
        },
      ],
    });

    const { suggestions } = parseResearchResultStreaming(text);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.plugin).toBe("marketing-expert");
  });

  test("leaves plugin undefined for an ordinary suggestion", () => {
    const text = JSON.stringify({
      claims: [],
      suggestions: [
        { suggestion: "I'll plan your trip", prompt: "Plan my trip" },
      ],
    });

    const { suggestions } = parseResearchResultStreaming(text);

    expect(suggestions[0]).toBeDefined();
    expect(suggestions[0]?.plugin).toBeUndefined();
  });

  test("trims plugin whitespace and drops blank tags", () => {
    const text = JSON.stringify({
      suggestions: [
        { suggestion: "a", prompt: "a", plugin: "  admin-copilot  " },
        { suggestion: "b", prompt: "b", plugin: "   " },
      ],
    });

    const { suggestions } = parseResearchResultStreaming(text);

    expect(suggestions[0]?.plugin).toBe("admin-copilot");
    expect(suggestions[1]?.plugin).toBeUndefined();
  });

  test("surfaces a tagged suggestion mid-stream before the array closes", () => {
    // Unterminated payload: suggestions array still open, trailing object
    // half-written. The first, complete object must still surface with its tag.
    const partial =
      '{ "claims": [], "suggestions": [ ' +
      '{ "suggestion": "I\'ll run GTM", "prompt": "Run my GTM", "plugin": "marketing-expert" }, ' +
      '{ "suggestion": "half';

    const { suggestions } = parseResearchResultStreaming(partial);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.plugin).toBe("marketing-expert");
  });
});
