import { describe, expect, test } from "bun:test";

import { ConceptPageFrontmatterSchema } from "../types.js";

/**
 * Regression: the frontmatter schema is `.passthrough()`, not `.strict()`.
 *
 * Migrated/converted corpora carry leaked source-page fields the article model
 * does not define (`date`, `sources`, `world`, `outcome`, `as_of`, …). Under
 * `.strict()` every such page threw in `readPage()` and was silently dropped
 * from BOTH the page index and the section dense lane (a bulk deploy of
 * summary-less wiki pages lost ~45% of them this way). `.passthrough()` keeps
 * them on disk and in the index; the frontmatter sweep still surfaces malformed
 * pages.
 */
describe("ConceptPageFrontmatterSchema", () => {
  test("tolerates unknown frontmatter keys instead of throwing (passthrough)", () => {
    const raw = {
      summary: "A page about something.",
      date: "2026-06-13",
      sources: ["source-a", "source-b"],
      world: "example-world",
      outcome: "resolved",
      as_of: "2026-06-13",
    };
    expect(() => ConceptPageFrontmatterSchema.parse(raw)).not.toThrow();
    const parsed = ConceptPageFrontmatterSchema.parse(raw) as Record<
      string,
      unknown
    >;
    // Declared field is typed/kept...
    expect(parsed.summary).toBe("A page about something.");
    // ...and unknown keys pass through rather than being stripped or rejected.
    expect(parsed.date).toBe("2026-06-13");
    expect(parsed.sources).toEqual(["source-a", "source-b"]);
    expect(parsed.outcome).toBe("resolved");
  });

  test("still applies declared-field defaults", () => {
    const parsed = ConceptPageFrontmatterSchema.parse({});
    expect(parsed.edges).toEqual([]);
    expect(parsed.ref_files).toEqual([]);
    expect(parsed.ref_urls).toEqual([]);
  });
});
