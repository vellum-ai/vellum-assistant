import {
  CircleX,
  Mail,
  MailOpen,
  MoreVertical,
  RotateCcw,
  X,
} from "lucide-react";

import { Button, Menu, Typography } from "@vellum/design-library";
import { CATEGORY_STYLES } from "../home-feed-filter-bar";
import { HomeGenericDetail } from "./home-generic-detail";
import { HomeToolPermissionCard } from "./home-tool-permission-card";
import type { FeedItem, FeedItemCategory, FeedItemStatus } from "../types";

function resolveCategoryStyle(category?: FeedItemCategory) {
  if (category && CATEGORY_STYLES[category]) {
    return CATEGORY_STYLES[category];
  }
  return CATEGORY_STYLES.system;
}

export interface HomeDetailPanelProps {
  item: FeedItem | null;
  validConversationIds: Set<string>;
  onClose: () => void;
  onGoToThread: (conversationId: string) => void;
  onUpdateStatus: (itemId: string, status: FeedItemStatus) => void;
  onDismiss: (itemId: string) => void;
}

export function HomeDetailPanel({
  item,
  validConversationIds,
  onClose,
  onGoToThread,
  onUpdateStatus,
  onDismiss,
}: HomeDetailPanelProps) {
  if (!item) {
    return null;
  }

  const panelKind = item.detailPanel?.kind;
  const categoryStyle = resolveCategoryStyle(item.category);
  const CategoryIcon = categoryStyle.icon;
  const isUnread = item.status === "new";
  const isDismissed = item.status === "dismissed";

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
          {item.title ?? item.summary}
        </Typography>

        {/* Go to Convo button — only when conversationId exists and is valid */}
        {item.conversationId && validConversationIds.has(item.conversationId) ? (
          <Button
            variant="outlined"
            size="compact"
            onClick={() => onGoToThread(item.conversationId!)}
          >
            Go to Convo
          </Button>
        ) : null}

        {/* Overflow menu — mark-as-read toggle + dismiss */}
        <Menu.Root>
          <Menu.Trigger>
            <Button
              variant="outlined"
              size="compact"
              iconOnly={<MoreVertical />}
              aria-label="More actions"
            />
          </Menu.Trigger>
          <Menu.Content align="end">
            {isDismissed ? (
              <Menu.Item
                onSelect={() => onUpdateStatus(item.id, "seen")}
                leftIcon={<RotateCcw className="size-4" />}
              >
                Restore
              </Menu.Item>
            ) : (
              <>
                <Menu.Item
                  onSelect={() =>
                    onUpdateStatus(item.id, isUnread ? "seen" : "new")
                  }
                  leftIcon={
                    isUnread ? (
                      <MailOpen className="size-4" />
                    ) : (
                      <Mail className="size-4" />
                    )
                  }
                >
                  {isUnread ? "Mark as read" : "Mark as unread"}
                </Menu.Item>
                <Menu.Item
                  onSelect={() => onDismiss(item.id)}
                  leftIcon={<CircleX className="size-4" />}
                >
                  Dismiss
                </Menu.Item>
              </>
            )}
          </Menu.Content>
        </Menu.Root>

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
