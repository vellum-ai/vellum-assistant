/**
 * Tests for `FeedCategoryChip` and the shared `resolveCategoryStyle` it uses.
 *
 * Uses `renderToStaticMarkup` (SSR) like `notifications-bell.test.tsx`. The
 * chip is a pure presentational component, so assertions cover rendered text
 * and the absence of throwing. Class strings are deliberately not asserted.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { FeedItemCategory } from "@vellumai/assistant-api";

import { FeedCategoryChip } from "@/domains/home/feed-category-chip";
import {
  CATEGORY_STYLES,
  resolveCategoryStyle,
} from "@/domains/home/home-feed-filter-bar";

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

describe("resolveCategoryStyle", () => {
  test.each(CATEGORY_LABELS)("returns the %s style", (category) => {
    expect(resolveCategoryStyle(category)).toBe(CATEGORY_STYLES[category]);
  });

  test("falls back to the system style when no category is given", () => {
    expect(resolveCategoryStyle()).toBe(CATEGORY_STYLES.system);
  });

  test("falls back to the system style for an unrecognized category", () => {
    expect(resolveCategoryStyle("nonsense" as FeedItemCategory)).toBe(
      CATEGORY_STYLES.system,
    );
  });
});
