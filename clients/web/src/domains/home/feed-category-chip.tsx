import { type CSSProperties } from "react";

import { useTranslation } from "@/i18n";
import type { FeedItemCategory } from "@vellumai/assistant-api";
import { Tag } from "@vellumai/design-library";

import { resolveCategoryStyle } from "./feed-category-styles";
import type { GuardianCategoryLabelKey } from "./utils";

export interface FeedCategoryChipProps {
  category?: FeedItemCategory;
  /**
   * Catalog key overriding the category's own label while keeping its
   * tone (guardian rows say what they need rather than "Security").
   */
  labelKey?: GuardianCategoryLabelKey;
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
export function FeedCategoryChip({
  category,
  labelKey,
}: FeedCategoryChipProps) {
  const { t } = useTranslation("home");
  const style = resolveCategoryStyle(category);

  return (
    <Tag
      className="bg-[var(--feed-chip-weak)] uppercase tracking-wide leading-none"
      style={{ "--feed-chip-weak": style.weak } as CSSProperties}
    >
      {t(labelKey ?? style.labelKey)}
    </Tag>
  );
}
