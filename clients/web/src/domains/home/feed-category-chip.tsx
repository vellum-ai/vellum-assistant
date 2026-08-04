import { type CSSProperties } from "react";

import type { FeedItemCategory } from "@vellumai/assistant-api";
import { Tag } from "@vellumai/design-library";

import { resolveCategoryStyle } from "./home-feed-filter-bar";

const FALLBACK_CATEGORY: FeedItemCategory = "system";

export interface FeedCategoryChipProps {
  category?: FeedItemCategory;
}

/**
 * Text-only chip naming a feed item's category, toned from `CATEGORY_STYLES`.
 *
 * The category tokens are runtime values, so they go in as local custom
 * properties that static Tailwind utilities read back. Those static utilities
 * land in the same `tailwind-merge` conflict groups as `Tag`'s own
 * `bg-[var(...)]` / `text-[color:var(...)]` base classes, so they win.
 */
export function FeedCategoryChip({ category }: FeedCategoryChipProps) {
  const style = resolveCategoryStyle(category);
  const label = category ?? FALLBACK_CATEGORY;

  return (
    <Tag
      className="bg-[var(--feed-chip-weak)] text-[color:var(--feed-chip-strong)] uppercase tracking-wide leading-none"
      style={
        {
          "--feed-chip-weak": style.weak,
          "--feed-chip-strong": style.strong,
        } as CSSProperties
      }
    >
      {label.charAt(0).toUpperCase() + label.slice(1)}
    </Tag>
  );
}
