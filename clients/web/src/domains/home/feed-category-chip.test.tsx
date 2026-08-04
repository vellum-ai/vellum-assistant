/**
 * Tests for `FeedCategoryChip`.
 *
 * Uses `renderToStaticMarkup` (SSR) like `notifications-bell.test.tsx`. The
 * chip is a pure presentational component, so assertions cover rendered text
 * and the absence of throwing. Class strings are deliberately not asserted.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { FeedItemCategory } from "@vellumai/assistant-api";

import { FeedCategoryChip } from "@/domains/home/feed-category-chip";

const CATEGORY_LABELS = [
  ["security", "Security"],
  ["email", "Email"],
  ["scheduling", "Scheduling"],
  ["background", "Background"],
  ["system", "System"],
] as const satisfies readonly (readonly [FeedItemCategory, string])[];

function stripTags(markup: string): string {
  return markup.replace(/<[^>]*>/g, "");
}

describe("FeedCategoryChip", () => {
  test.each(CATEGORY_LABELS)(
    "renders %s in natural case",
    (category, expected) => {
      const markup = renderToStaticMarkup(
        <FeedCategoryChip category={category} />,
      );
      expect(stripTags(markup)).toBe(expected);
    },
  );

  test("falls back to the system label when no category is given", () => {
    const markup = renderToStaticMarkup(<FeedCategoryChip />);
    expect(stripTags(markup)).toBe("System");
  });

  test("does not throw for an unrecognized category", () => {
    expect(() => {
      renderToStaticMarkup(
        <FeedCategoryChip category={"nonsense" as FeedItemCategory} />,
      );
    }).not.toThrow();
  });

  test("renders every category distinctly", () => {
    const rendered = CATEGORY_LABELS.map(([category]) =>
      renderToStaticMarkup(<FeedCategoryChip category={category} />),
    );
    expect(new Set(rendered).size).toBe(CATEGORY_LABELS.length);
  });
});
