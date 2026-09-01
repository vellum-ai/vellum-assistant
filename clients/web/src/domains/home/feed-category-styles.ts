import type { FeedItemCategory } from "@vellumai/assistant-api";

interface CategoryStyle {
  /** Background tone the category's chip is drawn in. */
  weak: string;
  /**
   * Written out per category rather than built from the wire value, so a
   * category added without its copy fails to compile and the key stays
   * greppable for the orphan check in `catalogs.test.ts`.
   */
  labelKey: `category.${FeedItemCategory}`;
}

/**
 * Per-category tone and label for a feed item, read by `FeedCategoryChip`.
 *
 * One table rather than a lookup built from the wire enum: a new category
 * has to be given its own tone and its own copy before this compiles.
 */
export const CATEGORY_STYLES: Record<FeedItemCategory, CategoryStyle> = {
  security: {
    weak: "var(--feed-nudge-weak)",
    labelKey: "category.security",
  },
  email: {
    weak: "var(--feed-digest-weak)",
    labelKey: "category.email",
  },
  scheduling: {
    weak: "var(--feed-thread-weak)",
    labelKey: "category.scheduling",
  },
  background: {
    weak: "var(--system-info-weak)",
    labelKey: "category.background",
  },
  system: {
    weak: "var(--feed-digest-weak)",
    labelKey: "category.system",
  },
};

/** Resolves a category to its style, falling back to `system`. */
export function resolveCategoryStyle(
  category?: FeedItemCategory,
): CategoryStyle {
  if (category && CATEGORY_STYLES[category]) {
    return CATEGORY_STYLES[category];
  }
  return CATEGORY_STYLES.system;
}
