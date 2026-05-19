import { X } from "lucide-react";
import { useState } from "react";

import { cn } from "@vellum/design-library";
import { CATEGORY_STYLES } from "./home-feed-filter-bar.js";
import type { FeedItem, FeedItemCategory } from "./types.js";

function resolveStyle(category?: FeedItemCategory) {
  if (category && CATEGORY_STYLES[category]) {
    return CATEGORY_STYLES[category];
  }
  return CATEGORY_STYLES.system;
}

export interface HomeRecapRowProps {
  item: FeedItem;
  onSelect: (item: FeedItem) => void;
  onDismiss: (itemId: string) => void;
}

export function HomeRecapRow({ item, onSelect, onDismiss }: HomeRecapRowProps) {
  const [isHovering, setIsHovering] = useState(false);
  const style = resolveStyle(item.category);
  const Icon = style.icon;
  const isUnread = item.status === "new";

  return (
    <button
      type="button"
      onClick={() => onSelect(item)}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
      className={cn(
        "flex w-full cursor-pointer items-center gap-[var(--app-spacing-sm)]",
        "rounded-[var(--radius-md)] px-[var(--app-spacing-md)] py-[var(--app-spacing-sm)]",
        "transition-[background-color,opacity] duration-150",
        isHovering
          ? "bg-[var(--surface-lift)]"
          : "bg-[var(--surface-overlay)]",
        !isUnread && "opacity-70",
      )}
    >
      <span className="relative shrink-0" aria-hidden="true">
        <span
          className="flex items-center justify-center rounded-full"
          style={{
            width: 26,
            height: 26,
            backgroundColor: style.weak,
          }}
        >
          <Icon width={12} height={12} style={{ color: style.strong }} />
        </span>
        {isUnread && (
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[var(--system-mid-strong)]" />
        )}
      </span>

      <span
        className={cn(
          "text-body-medium-default min-w-0 flex-1 truncate text-left",
          "text-[var(--content-secondary)]",
        )}
      >
        {item.title}
      </span>

      {isHovering ? (
        <span
          role="button"
          tabIndex={0}
          aria-label="Dismiss"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss(item.id);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
              e.preventDefault();
              onDismiss(item.id);
            }
          }}
          className={cn(
            "flex shrink-0 cursor-pointer items-center gap-[var(--app-spacing-xs)]",
            "text-[var(--content-disabled)]",
          )}
        >
          <X width={7} height={7} aria-hidden="true" />
          <span className="text-body-small-default">Dismiss</span>
        </span>
      ) : null}
    </button>
  );
}
