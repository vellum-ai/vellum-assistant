import { describe, expect, test } from "bun:test";

import { StoreStyleAnalysisSchema } from "./style-analyzer.js";

const validPattern = {
  aspect: "tone",
  summary: "Short and direct",
  importance: 0.9,
};

const validObservation = {
  name: "Alice",
  email: "user@example.com",
  tone_note: "casual",
};

describe("StoreStyleAnalysisSchema per-item tolerance", () => {
  test("a malformed contact observation does not discard style patterns", () => {
    const parsed = StoreStyleAnalysisSchema.safeParse({
      style_patterns: [validPattern],
      contact_observations: [{ name: "Bob", tone_note: "formal" }],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.style_patterns).toHaveLength(1);
    expect(parsed.data.contact_observations).toHaveLength(0);
  });

  test("a malformed style pattern is dropped while valid ones survive", () => {
    const parsed = StoreStyleAnalysisSchema.safeParse({
      style_patterns: [validPattern, { aspect: "greeting" }],
      contact_observations: [validObservation],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.style_patterns).toHaveLength(1);
    expect(parsed.data.style_patterns[0].summary).toBe("Short and direct");
    expect(parsed.data.contact_observations).toHaveLength(1);
  });

  test("omitted contact_observations yields an empty array", () => {
    const parsed = StoreStyleAnalysisSchema.safeParse({
      style_patterns: [validPattern],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.contact_observations).toEqual([]);
  });
});
