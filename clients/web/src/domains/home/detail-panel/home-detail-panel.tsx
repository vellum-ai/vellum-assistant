import { ArrowLeft, Mail, MailOpen, RotateCcw, Trash2, X } from "lucide-react";

import { useTranslation } from "@/i18n";
import { formatFullLocalDate, formatRelativeDate } from "@/utils/format-date";
import type { FeedItem, FeedItemStatus } from "@vellumai/assistant-api";
import { Button, Tag, Typography } from "@vellumai/design-library";
import { resolveCategoryStyle } from "../home-feed-filter-bar";
import type { FeedItemEntityLink } from "../hooks/use-feed-item-entity-links";
import { HomeGenericDetail } from "./home-generic-detail";
import { HomeToolPermissionCard } from "./home-tool-permission-card";

export interface HomeDetailPanelProps {
  item: FeedItem | null;
  isMobile?: boolean;
  validConversationIds: Set<string>;
  onClose: () => void;
  onGoToThread: (conversationId: string) => void;
  onUpdateStatus: (itemId: string, status: FeedItemStatus) => void;
  onDismiss: (itemId: string) => void;
  /**
   * Links to the entities this notification names (its schedule, the skill it
   * updated), already validated as still existing. Resolved by
   * `useFeedItemEntityLinks`; empty for an item that names none.
   */
  entityLinks?: FeedItemEntityLink[];
  /** Navigate to an entity link's `to` path. */
  onNavigate?: (to: string) => void;
}

export function HomeDetailPanel({
  item,
  isMobile,
  validConversationIds,
  onClose,
  onGoToThread,
  onUpdateStatus,
  onDismiss,
  entityLinks = [],
  onNavigate,
}: HomeDetailPanelProps) {
  const { t } = useTranslation("home");

  if (!item) {
    return null;
  }

  const panelKind = item.detailPanel?.kind;
  const categoryStyle = resolveCategoryStyle(item.category);
  // The header shows the item's own title when it has one. Many feed items
  // omit a distinct title, and falling back to `summary` (which is also the
  // body) duplicates the same text, so the category label stands in instead.
  const headerTitle = item.title
    ? item.title
    : item.category
      ? t(categoryStyle.labelKey)
      : t("homeDetailPanel.untitled");
  const CategoryIcon = categoryStyle.icon;
  const isUnread = item.status === "new";
  const readToggleLabel = isUnread
    ? t("actions.markAsRead")
    : t("actions.markAsUnread");
  const isDismissed = item.status === "dismissed";
  const hasValidConversation =
    !!item.conversationId && validConversationIds.has(item.conversationId);

  if (isMobile) {
    return (
      <div className="flex h-full flex-col bg-[var(--surface-overlay)]">
        {/* Nav bar */}
        <div className="relative flex shrink-0 items-center px-3 py-2">
          <Button
            variant="ghost"
            iconOnly={<ArrowLeft />}
            onClick={onClose}
            aria-label={t("homeDetailPanel.back")}
            tooltip={t("homeDetailPanel.back")}
          />

          <Typography
            variant="body-medium-default"
            className="pointer-events-none absolute inset-x-0 text-center text-[var(--content-secondary)]"
          >
            {t("homeDetailPanel.heading")}
          </Typography>

          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              iconOnly={isUnread ? <MailOpen /> : <Mail />}
              onClick={() => onUpdateStatus(item.id, isUnread ? "seen" : "new")}
              aria-label={readToggleLabel}
              tooltip={readToggleLabel}
            />
            {isDismissed ? (
              <Button
                variant="ghost"
                iconOnly={<RotateCcw />}
                onClick={() => onUpdateStatus(item.id, "seen")}
                aria-label={t("actions.restore")}
                tooltip={t("actions.restore")}
              />
            ) : (
              <Button
                variant="ghost"
                iconOnly={<Trash2 />}
                onClick={() => onDismiss(item.id)}
                aria-label={t("actions.dismiss")}
                tooltip={t("actions.dismiss")}
              />
            )}
          </div>
        </div>

        {/* Detail header */}
        <div className="flex items-center gap-3 px-4 py-3">
          <span
            className="flex shrink-0 items-center justify-center rounded-full"
            style={{
              width: 40,
              height: 40,
              backgroundColor: categoryStyle.weak,
            }}
            aria-hidden="true"
          >
            <CategoryIcon
              width={18}
              height={18}
              style={{ color: categoryStyle.strong }}
            />
          </span>
          <Typography
            variant="title-small"
            className="min-w-0 text-[var(--content-default)]"
          >
            {headerTitle}
          </Typography>
          <Tag
            tone="neutral"
            className="shrink-0"
            title={formatFullLocalDate(item.timestamp)}
          >
            {formatRelativeDate(item.timestamp)}
          </Tag>
        </div>

        {/* Divider */}
        <div className="mx-4 border-b border-[var(--border-disabled)]" />

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto p-4">
          {panelKind === "toolPermission" ? (
            <HomeToolPermissionCard item={item} />
          ) : (
            <HomeGenericDetail item={item} />
          )}
        </div>

        {/* Bottom CTA */}
        {hasValidConversation || entityLinks.length > 0 ? (
          <div className="flex shrink-0 flex-col gap-2 px-4 pb-4 pt-2">
            {entityLinks.map((link) => (
              <Button
                key={link.kind}
                variant="outlined"
                fullWidth
                leftIcon={<link.icon className="size-4" />}
                onClick={() => onNavigate?.(link.to)}
              >
                {t(link.labelKey)}
              </Button>
            ))}
            {hasValidConversation ? (
              <Button
                variant="primary"
                fullWidth
                onClick={() => onGoToThread(item.conversationId!)}
              >
                {t("actions.goToConversation")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col rounded-[var(--radius-xl)] border border-[var(--border-base)] bg-[var(--surface-overlay)]">
      {/* Header */}
      <div className="flex items-center gap-[var(--app-spacing-sm)] border-b border-[var(--border-base)] p-[var(--app-spacing-lg)]">
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
          {headerTitle}
        </Typography>

        {hasValidConversation ? (
          <Button
            variant="outlined"
            onClick={() => onGoToThread(item.conversationId!)}
          >
            {t("actions.goToConvo")}
          </Button>
        ) : null}

        <Button
          variant="outlined"
          iconOnly={<X />}
          onClick={onClose}
          aria-label={t("homeDetailPanel.closeAriaLabel")}
          tooltip={t("homeDetailPanel.close")}
        />
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto p-[var(--app-spacing-lg)]">
        {panelKind === "toolPermission" ? (
          <HomeToolPermissionCard item={item} />
        ) : (
          <HomeGenericDetail item={item} />
        )}
        <div className="mt-[var(--app-spacing-md)]">
          <Tag tone="neutral" title={formatFullLocalDate(item.timestamp)}>
            {formatRelativeDate(item.timestamp)}
          </Tag>
        </div>
      </div>

      {/* Footer actions */}
      <div className="flex shrink-0 items-center justify-between gap-[var(--app-spacing-sm)] border-t border-[var(--border-base)] p-[var(--app-spacing-lg)]">
        <div className="flex items-center gap-[var(--app-spacing-sm)]">
          {entityLinks.map((link) => (
            <Button
              key={link.kind}
              variant="outlined"
              leftIcon={<link.icon className="size-4" />}
              onClick={() => onNavigate?.(link.to)}
            >
              {t(link.labelKey)}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-[var(--app-spacing-sm)]">
          {isDismissed ? (
            <Button
              variant="primary"
              onClick={() => onUpdateStatus(item.id, "seen")}
            >
              {t("actions.restore")}
            </Button>
          ) : (
            <>
              <Button
                variant="outlined"
                onClick={() =>
                  onUpdateStatus(item.id, isUnread ? "seen" : "new")
                }
              >
                {readToggleLabel}
              </Button>
              <Button variant="primary" onClick={() => onDismiss(item.id)}>
                {t("actions.dismiss")}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
