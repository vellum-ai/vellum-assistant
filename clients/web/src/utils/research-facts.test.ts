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

import {
  parseResearchResultStreaming,
  pluginDisplayName,
} from "@/utils/research-facts";

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

describe("parseResearchResultStreaming — completeness signal", () => {
  test("a fully-formed payload is complete and keeps every suggestion", () => {
    const text = JSON.stringify({
      claims: [{ claim: "Founder", confidence: "confident", sources: [] }],
      suggestions: [
        { suggestion: "one", prompt: "one" },
        { suggestion: "two", prompt: "two" },
        { suggestion: "three", prompt: "three" },
        { suggestion: "four", prompt: "four" },
      ],
    });

    const { suggestions, complete } = parseResearchResultStreaming(text);

    expect(complete).toBe(true);
    expect(suggestions).toHaveLength(4);
  });

  test("a payload buried in surrounding prose still parses complete", () => {
    const text =
      'Here is what I found:\n' +
      JSON.stringify({
        suggestions: [
          { suggestion: "a", prompt: "a" },
          { suggestion: "b", prompt: "b" },
        ],
      }) +
      "\nLet me know!";

    const { suggestions, complete } = parseResearchResultStreaming(text);

    expect(complete).toBe(true);
    expect(suggestions).toHaveLength(2);
  });

  test("a still-streaming payload is reported incomplete", () => {
    const partial =
      '{ "claims": [], "suggestions": [ { "suggestion": "first", "prompt": "first" }, { "suggestion": "sec';

    const { suggestions, complete } = parseResearchResultStreaming(partial);

    expect(complete).toBe(false);
    expect(suggestions).toHaveLength(1);
  });

  test("escaped quotes inside a value survive the whole-payload parse", () => {
    // The card text legitimately contains an escaped double quote — JSON.parse
    // handles it, so all suggestions must survive (the brace-counted fallback
    // would otherwise desync and drop the rest).
    const text = JSON.stringify({
      suggestions: [
        { suggestion: 'I\'ll track your "sends"', prompt: "Track my sends." },
        { suggestion: "I'll plan your week", prompt: "Plan my week." },
      ],
    });

    const { suggestions, complete } = parseResearchResultStreaming(text);

    expect(complete).toBe(true);
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]?.suggestion).toBe('I\'ll track your "sends"');
  });
});

describe("pluginDisplayName", () => {
  test("title-cases a hyphenated install name", () => {
    expect(pluginDisplayName("marketing-expert")).toBe("Marketing Expert");
  });

  test("handles underscores and extra whitespace", () => {
    expect(pluginDisplayName("admin_copilot")).toBe("Admin Copilot");
    expect(pluginDisplayName("  growth   coach ")).toBe("Growth Coach");
  });

  test("leaves a single word capitalized", () => {
    expect(pluginDisplayName("recruiter")).toBe("Recruiter");
  });

  test("returns an empty string for blank input", () => {
    expect(pluginDisplayName("   ")).toBe("");
    expect(pluginDisplayName("")).toBe("");
  });
});
