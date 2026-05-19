import { Typography } from "@vellum/design-library";
import { CATEGORY_STYLES, CATEGORY_ORDER } from "../home-feed-filter-bar.js";
import type { FeedItem, FeedItemCategory } from "../types.js";

function resolveStyle(category?: FeedItemCategory) {
  if (category && CATEGORY_STYLES[category]) {
    return CATEGORY_STYLES[category];
  }
  const fallback = CATEGORY_ORDER[0] ?? "security";
  return CATEGORY_STYLES[fallback];
}

export interface HomeGenericDetailProps {
  item: FeedItem;
}

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

      <Typography
        variant="body-medium-default"
        className="text-[var(--content-secondary)]"
      >
        {item.summary}
      </Typography>
    </div>
  );
}
