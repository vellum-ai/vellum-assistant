/**
 * Contract tests for the research-fact parser's top-level `plugins` install
 * list.
 *
 * The research-onboarding flow lets the assistant pick the marketplace
 * capabilities that best fit the person (a persona-level `plugins` array, NOT
 * tied to any one suggestion); the runner installs them for the assistant. These
 * tests pin that the array round-trips, normalizes (trim/dedupe/drop non-string)
 * and — because the runner must never act on a half-written array — is only
 * honored once the whole payload parses complete.
 */

import { describe, expect, test } from "bun:test";

import {
  parseResearchResultStreaming,
  pluginDisplayName,
} from "@/utils/research-facts";

describe("parseResearchResultStreaming — plugins install list", () => {
  test("parses the top-level plugins array", () => {
    const text = JSON.stringify({
      claims: [],
      suggestions: [{ suggestion: "a", prompt: "a" }],
      plugins: ["marketing-expert", "admin-copilot"],
    });

    const { plugins } = parseResearchResultStreaming(text);

    expect(plugins).toEqual(["marketing-expert", "admin-copilot"]);
  });

  test("defaults to an empty array when the key is absent", () => {
    const text = JSON.stringify({
      claims: [],
      suggestions: [{ suggestion: "I'll plan your trip", prompt: "Plan my trip" }],
    });

    const { plugins } = parseResearchResultStreaming(text);

    expect(plugins).toEqual([]);
  });

  test("trims, de-dupes, and drops blank or non-string entries", () => {
    const text = JSON.stringify({
      suggestions: [{ suggestion: "a", prompt: "a" }],
      plugins: ["  admin-copilot  ", "admin-copilot", "   ", 7, "growth-coach"],
    });

    const { plugins } = parseResearchResultStreaming(text);

    expect(plugins).toEqual(["admin-copilot", "growth-coach"]);
  });

  test("is honored as soon as its array closes, before the payload completes", () => {
    // The prompt emits `plugins` first so installs can start ASAP. A closed
    // plugins array is honored — and marked resolved — even while claims/
    // suggestions are still streaming.
    const partial =
      '{ "plugins": ["github", "marketing-expert"], "claims": [ { "claim": "Founder';

    const { plugins, pluginsResolved, complete } =
      parseResearchResultStreaming(partial);

    expect(complete).toBe(false);
    expect(pluginsResolved).toBe(true);
    expect(plugins).toEqual(["github", "marketing-expert"]);
  });

  test("a closed-but-empty array is resolved (the model picked none)", () => {
    // `[]` that has fully closed is a final decision, not a not-yet — so the
    // click gate can release without waiting on the rest of the turn.
    const partial = '{ "plugins": [], "claims": [ { "claim": "Founder';

    const { plugins, pluginsResolved } = parseResearchResultStreaming(partial);

    expect(pluginsResolved).toBe(true);
    expect(plugins).toEqual([]);
  });

  test("a still-open plugins array is unresolved (avoids a truncated name)", () => {
    // Half-written array, no closing `]`: acting on it could install a truncated
    // name, so it stays empty AND unresolved until the array terminates.
    const partial = '{ "plugins": [ "marketing-exp';

    const { plugins, pluginsResolved } = parseResearchResultStreaming(partial);

    expect(plugins).toEqual([]);
    expect(pluginsResolved).toBe(false);
  });

  test("plugins are unresolved before the array appears", () => {
    const partial = '{ "claims": [ { "claim": "Founder';

    const { pluginsResolved } = parseResearchResultStreaming(partial);

    expect(pluginsResolved).toBe(false);
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
