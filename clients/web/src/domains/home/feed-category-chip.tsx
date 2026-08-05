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
 * The background alone carries the category hue: the `weak` token is a runtime
 * value, so it goes in as a local custom property that a static Tailwind
 * utility reads back, landing in the same `tailwind-merge` conflict group as
 * `Tag`'s own `bg-[var(...)]` base class so it wins. The label deliberately
 * keeps `Tag`'s `--content-default` text color, which clears WCAG AA against
 * every category background at this 12px/600 size.
 */
export function FeedCategoryChip({ category }: FeedCategoryChipProps) {
  const style = resolveCategoryStyle(category);
  const label = category ?? FALLBACK_CATEGORY;

  return (
    <Tag
      className="bg-[var(--feed-chip-weak)] uppercase tracking-wide leading-none"
      style={{ "--feed-chip-weak": style.weak } as CSSProperties}
    >
      {label.charAt(0).toUpperCase() + label.slice(1)}
    </Tag>
  );
}
