import { type CSSProperties } from "react";

import { useTranslation } from "@/i18n";
import type { FeedItemCategory } from "@vellumai/assistant-api";
import { cn } from "@vellumai/design-library";

import { resolveCategoryStyle } from "./home-feed-filter-bar";

/**
 * Sizes the three detail headers draw this at. The Activity page's panel is
 * roomy on mobile and tighter on desktop; the bell's popover header is tighter
 * still, sharing a 384px row with three controls.
 */
export type FeedCategoryIconSize = "sm" | "md" | "lg";

/** Wrapper and glyph sizes per step, on the 4px grid. */
const SIZE_CLASSES: Record<
  FeedCategoryIconSize,
  { wrapper: string; glyph: string }
> = {
  sm: { wrapper: "size-6", glyph: "size-3" },
  md: { wrapper: "size-7", glyph: "size-3.5" },
  lg: { wrapper: "size-10", glyph: "size-[18px]" },
};

export interface FeedCategoryIconProps {
  category?: FeedItemCategory;
  size?: FeedCategoryIconSize;
}

/**
 * A feed item's category as a glyph on a filled circle, toned from
 * `CATEGORY_STYLES`. The counterpart to {@link FeedCategoryChip}, which names
 * the category in text where there is room for a word.
 *
 * Both hues are runtime values, so they go in as local custom properties that
 * static Tailwind utilities read back, the same way the chip carries its
 * background. Sizes stay on the spacing scale rather than in a `style` object,
 * since only the two colors need to be dynamic.
 *
 * Named rather than hidden: in every header that draws this, the category is
 * carried by the glyph alone, so hiding it drops the notification's category
 * from the accessibility tree entirely. `role="img"` goes with the label so
 * assistive tech reports one image instead of walking into the SVG (see
 * https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Roles/img_role).
 * On an untitled item the Activity panel's heading falls back to this same
 * category name, so it is announced twice there; a duplicate reading is the
 * better failure than a silent one.
 */
export function FeedCategoryIcon({
  category,
  size = "md",
}: FeedCategoryIconProps) {
  const { t } = useTranslation("home");
  const style = resolveCategoryStyle(category);
  const Icon = style.icon;
  const sizes = SIZE_CLASSES[size];

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-[var(--feed-category-weak)]",
        sizes.wrapper,
      )}
      style={
        {
          "--feed-category-weak": style.weak,
          "--feed-category-strong": style.strong,
        } as CSSProperties
      }
      role="img"
      aria-label={t(style.labelKey)}
    >
      <Icon
        className={cn(sizes.glyph, "text-[var(--feed-category-strong)]")}
        aria-hidden="true"
      />
    </span>
  );
}
