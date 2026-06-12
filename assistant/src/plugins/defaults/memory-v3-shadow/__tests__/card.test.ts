/**
 * Tests for `card.ts` — the compact card renderer. Focused on the annotation
 * line: it must sit directly under the header (the always-rendered card
 * surface) and leave the card untouched when absent.
 */

import { describe, expect, test } from "bun:test";

import { renderCard } from "../card.js";

const PAGE = `---
title: Page A
---

Lead paragraph for page a.

## Alpha

Body text.
`;

describe("renderCard — annotation line", () => {
  test("renders the annotation directly under the header, before the head", () => {
    const card = renderCard(
      "page-a",
      PAGE,
      "[lane: fresh · updated 2026-06-10 14:23 UTC]",
    );
    expect(
      card.startsWith(
        "# memory/concepts/page-a.md\n[lane: fresh · updated 2026-06-10 14:23 UTC]\nLead paragraph for page a.",
      ),
    ).toBe(true);
    expect(card).toContain("[sections: §Alpha]");
  });

  test("an absent or empty annotation leaves the card unchanged", () => {
    const bare = renderCard("page-a", PAGE);
    expect(renderCard("page-a", PAGE, "")).toBe(bare);
    expect(bare).not.toContain("[lane:");
    expect(
      bare.startsWith(
        "# memory/concepts/page-a.md\nLead paragraph for page a.",
      ),
    ).toBe(true);
  });

  test("annotates a page with no head section without a dangling blank line", () => {
    const card = renderCard(
      "page-b",
      "## Only Section\n\nBody.",
      "[lane: core]",
    );
    expect(card.startsWith("# memory/concepts/page-b.md\n[lane: core]")).toBe(
      true,
    );
  });
});
