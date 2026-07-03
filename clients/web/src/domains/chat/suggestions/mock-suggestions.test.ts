import { describe, expect, it } from "bun:test";

import {
  MOCK_SUGGESTION_GROUPS,
  getFeaturedSuggestions,
} from "./mock-suggestions";

describe("MOCK_SUGGESTION_GROUPS", () => {
  it("includes at least one plugin and one vellum-curated group", () => {
    const sources = new Set(MOCK_SUGGESTION_GROUPS.map((g) => g.source));
    expect(sources.has("plugin")).toBe(true);
    expect(sources.has("vellum-curated")).toBe(true);
  });

  it("has a curated group with at least 5 suggestions", () => {
    const curated = MOCK_SUGGESTION_GROUPS.find(
      (g) => g.source === "vellum-curated",
    );
    expect(curated).toBeDefined();
    expect(curated!.suggestions.length).toBeGreaterThanOrEqual(5);
  });

  it("has a unique id for every suggestion across all groups", () => {
    const ids = MOCK_SUGGESTION_GROUPS.flatMap((g) =>
      g.suggestions.map((s) => s.id),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("getFeaturedSuggestions", () => {
  it("returns exactly 3 items by default", () => {
    expect(getFeaturedSuggestions(3)).toHaveLength(3);
  });
});
