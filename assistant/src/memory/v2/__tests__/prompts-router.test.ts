/**
 * Tests for `assistant/src/memory/v2/prompts/router.ts` —
 * specifically `renderRouterPrompt`, which substitutes the assistant name,
 * user name, and rendered page index into the bundled router prompt body.
 */
import { describe, expect, test } from "bun:test";

import { renderRouterPrompt } from "../prompts/router.js";

const SAMPLE_INDEX = `[1] morning-routine — coffee, walk, journal (edges: 2)
[2] journal-style — terse, dated, no fluff (edges: 1)
[3] taxes-2025 — Q1 estimate due April 15 (edges: )`;

describe("renderRouterPrompt — substitution", () => {
  test("replaces all three placeholders with the supplied values", () => {
    const out = renderRouterPrompt({
      assistantName: "Aria",
      userName: "Alice",
      pageIndexBlock: SAMPLE_INDEX,
    });

    expect(out).not.toContain("{{ASSISTANT_NAME}}");
    expect(out).not.toContain("{{USER_NAME}}");
    expect(out).not.toContain("{{PAGE_INDEX}}");
    expect(out).toContain("Aria");
    expect(out).toContain("Alice");
    expect(out).toContain(SAMPLE_INDEX);
  });

  test("substitutes every occurrence of the assistant name placeholder", () => {
    const out = renderRouterPrompt({
      assistantName: "Aria",
      userName: "Alice",
      pageIndexBlock: SAMPLE_INDEX,
    });

    // Body references the assistant name in multiple sentences; ensure none
    // of them leak the raw placeholder.
    const matches = out.match(/Aria/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe("renderRouterPrompt — neutral fallbacks", () => {
  test("falls back to 'the assistant' when assistantName is null", () => {
    const out = renderRouterPrompt({
      assistantName: null,
      userName: "Alice",
      pageIndexBlock: SAMPLE_INDEX,
    });

    expect(out).toContain("the assistant");
    expect(out).not.toContain("{{ASSISTANT_NAME}}");
  });

  test("falls back to 'the user' when userName is null", () => {
    const out = renderRouterPrompt({
      assistantName: "Aria",
      userName: null,
      pageIndexBlock: SAMPLE_INDEX,
    });

    expect(out).toContain("the user");
    expect(out).not.toContain("{{USER_NAME}}");
  });

  test("uses both fallbacks when both names are null", () => {
    const out = renderRouterPrompt({
      assistantName: null,
      userName: null,
      pageIndexBlock: SAMPLE_INDEX,
    });

    expect(out).toContain("the assistant");
    expect(out).toContain("the user");
  });

  test("falls back when names are whitespace-only strings", () => {
    const out = renderRouterPrompt({
      assistantName: "   ",
      userName: "\t\n",
      pageIndexBlock: SAMPLE_INDEX,
    });

    expect(out).toContain("the assistant");
    expect(out).toContain("the user");
  });
});

describe("renderRouterPrompt — page index handling", () => {
  test("substitutes an empty pageIndexBlock cleanly without double-newline artifacts", () => {
    const out = renderRouterPrompt({
      assistantName: "Aria",
      userName: "Alice",
      pageIndexBlock: "",
    });

    expect(out).not.toContain("{{PAGE_INDEX}}");
    // The header should still be present and not followed by a stray
    // triple-newline run from collapsing the empty block.
    expect(out).toContain("# Concept Page Index");
    expect(out).not.toMatch(/\n\n\n/);
    // Output should end at the header section without trailing whitespace.
    expect(out.endsWith("# Concept Page Index\n\n")).toBe(true);
  });

  test("preserves the page index body verbatim, including edges syntax", () => {
    const out = renderRouterPrompt({
      assistantName: "Aria",
      userName: "Alice",
      pageIndexBlock: SAMPLE_INDEX,
    });

    expect(out).toContain(
      "[1] morning-routine — coffee, walk, journal (edges: 2)",
    );
    expect(out).toContain(
      "[3] taxes-2025 — Q1 estimate due April 15 (edges: )",
    );
  });
});

describe("renderRouterPrompt — determinism & snapshot stability", () => {
  test("returns the same string for the same inputs", () => {
    const opts = {
      assistantName: "Aria",
      userName: "Alice",
      pageIndexBlock: SAMPLE_INDEX,
    };
    expect(renderRouterPrompt(opts)).toBe(renderRouterPrompt(opts));
  });

  test("snapshot of fixed inputs", () => {
    const out = renderRouterPrompt({
      assistantName: "Aria",
      userName: "Alice",
      pageIndexBlock: SAMPLE_INDEX,
    });

    expect(out).toMatchSnapshot();
  });
});

describe("renderRouterPrompt — content expectations", () => {
  test("references the select_pages_to_inject tool name", () => {
    const out = renderRouterPrompt({
      assistantName: "Aria",
      userName: "Alice",
      pageIndexBlock: SAMPLE_INDEX,
    });

    expect(out).toContain("select_pages_to_inject");
  });

  test("describes the already_injected_ids and now markers", () => {
    const out = renderRouterPrompt({
      assistantName: "Aria",
      userName: "Alice",
      pageIndexBlock: SAMPLE_INDEX,
    });

    expect(out).toContain("<already_injected_ids>");
    expect(out).toContain("<now>");
  });

  test("warns against duplicating the always-on essentials block", () => {
    const out = renderRouterPrompt({
      assistantName: "Aria",
      userName: "Alice",
      pageIndexBlock: SAMPLE_INDEX,
    });

    expect(out.toLowerCase()).toContain("essentials");
  });
});
