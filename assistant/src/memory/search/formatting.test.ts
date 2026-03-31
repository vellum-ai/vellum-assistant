/**
 * Unit tests for buildMemoryInjection — focused on echoes/serendipity
 * rendering and budget enforcement.
 */
import { describe, expect, test } from "bun:test";

import { buildMemoryInjection } from "./formatting.js";
import type { Candidate } from "./types.js";

type CandidateWithLabel = Candidate & { sourceLabel?: string };

function makeCandidate(
  overrides: Partial<CandidateWithLabel> & { id: string },
): CandidateWithLabel {
  return {
    key: `item:${overrides.id}`,
    type: "item",
    source: "semantic",
    text: overrides.text ?? `Statement for ${overrides.id}`,
    kind: overrides.kind ?? "fact",
    confidence: 1,
    importance: overrides.importance ?? 0.5,
    createdAt: overrides.createdAt ?? Date.now(),
    semantic: 0.8,
    recency: 0.5,
    finalScore: overrides.finalScore ?? 0.6,
    ...overrides,
  };
}

describe("buildMemoryInjection — echoes section", () => {
  test("renders <echoes> after <recalled> when serendipity items provided", () => {
    const candidates = [makeCandidate({ id: "c1", finalScore: 0.8 })];
    const serendipityItems = [
      makeCandidate({ id: "s1", finalScore: 0, importance: 0.7 }),
    ];

    const result = buildMemoryInjection({
      candidates,
      serendipityItems,
      totalBudgetTokens: 2000,
    });

    expect(result).toContain("<recalled>");
    expect(result).toContain("</recalled>");
    expect(result).toContain("<echoes>");
    expect(result).toContain("</echoes>");
    // <echoes> comes after </recalled>
    const recalledEnd = result.indexOf("</recalled>");
    const echoesStart = result.indexOf("<echoes>");
    expect(echoesStart).toBeGreaterThan(recalledEnd);
  });

  test("renders only <echoes> when no recalled candidates but serendipity items exist", () => {
    const serendipityItems = [
      makeCandidate({ id: "s1", finalScore: 0, importance: 0.6 }),
      makeCandidate({ id: "s2", finalScore: 0, importance: 0.4 }),
    ];

    const result = buildMemoryInjection({
      candidates: [],
      serendipityItems,
      totalBudgetTokens: 2000,
    });

    expect(result).toContain("<memory_context");
    expect(result).not.toContain("<recalled>");
    expect(result).toContain("<echoes>");
    expect(result).toContain("</echoes>");
    expect(result).toContain("s1");
    expect(result).toContain("s2");
  });

  test("echoes section respects ~400 token cap", () => {
    // Create serendipity items with very long text to test budget
    const longText = "word ".repeat(200); // ~200 tokens
    const serendipityItems = [
      makeCandidate({ id: "s1", text: longText, finalScore: 0 }),
      makeCandidate({ id: "s2", text: longText, finalScore: 0 }),
      makeCandidate({ id: "s3", text: longText, finalScore: 0 }),
    ];

    const result = buildMemoryInjection({
      candidates: [],
      serendipityItems,
      totalBudgetTokens: 5000, // plenty of total budget
    });

    // At ~200 tokens each, the 400-token echoes cap should allow at most 2
    const itemMatches = result.match(/<item /g) ?? [];
    expect(itemMatches.length).toBeLessThanOrEqual(2);
  });

  test("no <echoes> section when serendipity array is empty", () => {
    const candidates = [makeCandidate({ id: "c1", finalScore: 0.8 })];

    const result = buildMemoryInjection({
      candidates,
      serendipityItems: [],
      totalBudgetTokens: 2000,
    });

    expect(result).toContain("<recalled>");
    expect(result).not.toContain("<echoes>");
  });

  test("no <echoes> section when serendipity items omitted", () => {
    const candidates = [makeCandidate({ id: "c1", finalScore: 0.8 })];

    const result = buildMemoryInjection({
      candidates,
      totalBudgetTokens: 2000,
    });

    expect(result).toContain("<recalled>");
    expect(result).not.toContain("<echoes>");
  });

  test("echoes items include importance and kind attributes", () => {
    const serendipityItems = [
      makeCandidate({
        id: "echo1",
        kind: "preference",
        importance: 0.85,
        text: "User likes dark mode",
        finalScore: 0,
      }),
    ];

    const result = buildMemoryInjection({
      candidates: [],
      serendipityItems,
      totalBudgetTokens: 2000,
    });

    expect(result).toContain('kind="preference"');
    expect(result).toContain('importance="0.85"');
    expect(result).toContain("User likes dark mode");
  });
});
