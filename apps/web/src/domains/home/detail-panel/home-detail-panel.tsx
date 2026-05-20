import { Circle, CircleCheck, X } from "lucide-react";

import { Button, Typography } from "@vellum/design-library";
import { CATEGORY_STYLES } from "../home-feed-filter-bar.js";
import { HomeGenericDetail } from "./home-generic-detail.js";
import { HomeToolPermissionCard } from "./home-tool-permission-card.js";
import type { FeedItem, FeedItemCategory, FeedItemStatus } from "../types.js";

function resolveCategoryStyle(category?: FeedItemCategory) {
  if (category && CATEGORY_STYLES[category]) {
    return CATEGORY_STYLES[category];
  }
  return CATEGORY_STYLES.system;
}

export interface HomeDetailPanelProps {
  item: FeedItem | null;
  onClose: () => void;
  onGoToThread: (conversationId: string) => void;
  onUpdateStatus: (itemId: string, status: FeedItemStatus) => void;
}

export function HomeDetailPanel({
  item,
  onClose,
  onGoToThread,
  onUpdateStatus,
}: HomeDetailPanelProps) {
  if (!item) return null;

  const panelKind = item.detailPanel?.kind;
  const categoryStyle = resolveCategoryStyle(item.category);
  const CategoryIcon = categoryStyle.icon;
  const isUnread = item.status === "new";

  return (
    <div className="flex h-full flex-col rounded-[var(--radius-lg)] border border-[var(--border-base)] bg-[var(--surface-overlay)]">
      {/* Header */}
      <div className="flex items-center gap-[var(--app-spacing-sm)] border-b border-[var(--border-base)] px-[var(--app-spacing-lg)] py-[var(--app-spacing-md)]">
        <span
          className="flex shrink-0 items-center justify-center rounded-full"
          style={{
            width: 28,
            height: 28,
            backgroundColor: categoryStyle.weak,
          }}
          aria-hidden="true"
        >
          <CategoryIcon
            width={14}
            height={14}
            style={{ color: categoryStyle.strong }}
          />
        </span>

        <Typography
          variant="title-small"
          className="min-w-0 flex-1 truncate text-[var(--content-default)]"
        >
          {item.title}
        </Typography>

        <Button
          variant="outlined"
          size="compact"
          iconOnly={isUnread ? <CircleCheck /> : <Circle />}
          onClick={() =>
            onUpdateStatus(item.id, isUnread ? "seen" : "new")
          }
          aria-label={isUnread ? "Mark as read" : "Mark as unread"}
          title={isUnread ? "Mark as read" : "Mark as unread"}
        />

        {item.conversationId ? (
          <Button
            variant="outlined"
            size="compact"
            onClick={() => onGoToThread(item.conversationId!)}
          >
            Go to Thread
          </Button>
        ) : null}

        <Button
          variant="outlined"
          size="compact"
          iconOnly={<X />}
          onClick={onClose}
          aria-label="Close detail panel"
        />
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto p-[var(--app-spacing-lg)]">
        {panelKind === "toolPermission" ? (
          <HomeToolPermissionCard item={item} />
        ) : (
          <HomeGenericDetail item={item} />
        )}
      </div>
    </div>
  );
}
