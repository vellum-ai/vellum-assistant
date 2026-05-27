import { CATEGORY_STYLES } from "../home-feed-filter-bar";
import { HomeMarkdownContent } from "./home-markdown-content";
import type { FeedItem, FeedItemCategory } from "../types";

function resolveStyle(category?: FeedItemCategory) {
  if (category && CATEGORY_STYLES[category]) {
    return CATEGORY_STYLES[category];
  }
  return CATEGORY_STYLES.system;
}

export interface HomeGenericDetailProps {
  item: FeedItem;
}

/**
 * Fallback renderer for feed items that don't have a specialized
 * detail panel. Renders the item summary as markdown alongside a
 * category-colored icon.
 */
export function HomeGenericDetail({ item }: HomeGenericDetailProps) {
  const style = resolveStyle(item.category);
  const Icon = style.icon;

  return (
    <div className="flex items-start gap-[var(--app-spacing-md)]">
      <span
        className="mt-0.5 flex shrink-0 items-center justify-center rounded-full"
        style={{
          width: 26,
          height: 26,
          backgroundColor: style.weak,
        }}
        aria-hidden="true"
      >
        <Icon width={12} height={12} style={{ color: style.strong }} />
      </span>

      <HomeMarkdownContent content={item.summary} />
    </div>
  );
}
