import { ChevronLeft, Mail, MailOpen, RotateCcw, Trash2 } from "lucide-react";

import { useTranslation } from "@/i18n";
import {
  formatCompactLocalDate,
  formatFullLocalDate,
} from "@/utils/format-date";
import type { FeedItem, FeedItemStatus } from "@vellumai/assistant-api";
import { Button, Typography } from "@vellumai/design-library";

import { HomeGenericDetail } from "../detail-panel/home-generic-detail";
import { HomeToolPermissionCard } from "../detail-panel/home-tool-permission-card";
import type { FeedItemEntityLink } from "../hooks/use-feed-item-entity-links";
import { resolveFeedItemTitle } from "../utils";

/**
 * Layout of the panel's header row. Shared with the notifications list so the
 * header occupies the same box in both views and the popover keeps its shape
 * when they swap.
 */
export const NOTIFICATIONS_PANEL_HEADER_CLASS =
  "mb-[var(--app-spacing-sm)] flex min-h-8 items-center gap-[var(--app-spacing-xs)]";

/**
 * Notification bodies read as prose here, so paragraphs and list items take a
 * 1.5 ratio in place of the 18px line height the body token pairs with its
 * 14px text. Scoped to this panel, leaving the Activity page's detail on the
 * token default.
 */
const BODY_LEADING_CLASS = "[&_p]:leading-normal [&_li]:leading-normal";

export interface NotificationsBellDetailProps {
  item: FeedItem;
  /**
   * Height of the scrollable content region. The bell passes the budget the
   * list is capped at, and the detail takes it as a fixed height so every
   * notification renders in an identically sized frame.
   */
  contentHeight: string;
  /**
   * Ceiling on that frame, expressed against the viewport rather than the
   * content, so a viewport too short to seat the budget shrinks the frame
   * instead of overflowing. Together with `contentHeight` this is the minimum
   * of the two. Omitted where an ancestor already scrolls.
   */
  contentMaxHeight?: string;
  /**
   * Ids of the conversations that still exist, merged from the foreground,
   * background, and scheduled lists exactly as the Activity page merges them.
   */
  validConversationIds: Set<string>;
  /** True while any of those lists has yet to resolve. */
  areConversationListsPending: boolean;
  /**
   * Links to the entities this notification names (its schedule, the skill it
   * updated), from `useFeedItemEntityLinks`. A link whose list has yet to
   * resolve is included and flagged by `areEntityLinksPending`.
   */
  entityLinks: FeedItemEntityLink[];
  /** True while a list one of those links depends on has yet to resolve. */
  areEntityLinksPending: boolean;
  /** True while an action item's conversation is being created. */
  isActionPending: boolean;
  onBack: () => void;
  onGoToConversation: (conversationId: string) => void;
  /** Navigate to an entity link's `to` path, closing the bell. */
  onNavigate: (to: string) => void;
  onUpdateStatus: (itemId: string, status: FeedItemStatus) => void;
  onDismiss: (itemId: string) => void;
  onTriggerAction: (actionId: string) => void;
}

/**
 * One notification's detail, rendered inside the bell in place of the list.
 * The body renderers and the panel-kind rule are the Activity page's, so a
 * notification reads the same wherever it is opened from.
 */
export function NotificationsBellDetail({
  item,
  contentHeight,
  contentMaxHeight,
  validConversationIds,
  areConversationListsPending,
  entityLinks,
  areEntityLinksPending,
  isActionPending,
  onBack,
  onGoToConversation,
  onNavigate,
  onUpdateStatus,
  onDismiss,
  onTriggerAction,
}: NotificationsBellDetailProps) {
  const { t } = useTranslation("home");
  const conversationId = item.conversationId ?? null;
  const isUnread = item.status === "new";
  const readToggleLabel = isUnread
    ? t("actions.markAsRead")
    : t("actions.markAsUnread");
  const isDismissed = item.status === "dismissed";
  const actions = item.actions ?? [];

  // Same rule as the Activity page's detail panel, plus a pending case the
  // page doesn't have: the lists start loading when this view opens. Every
  // list a candidate link depends on has to land before any link becomes
  // reachable, so the buttons settle together rather than one at a time and a
  // deleted target is never linked to.
  const isValidationPending =
    (conversationId !== null && areConversationListsPending) ||
    areEntityLinksPending;

  // A link the lists have yet to vouch for still renders, holding the box it
  // will occupy so the footer keeps its shape once validation resolves. One
  // whose target turns out to be gone drops out (entity links are dropped by
  // the resolver itself, the conversation link here).
  const linkedConversationId =
    conversationId !== null &&
    (isValidationPending || validConversationIds.has(conversationId))
      ? conversationId
      : null;

  // `visibility: hidden` keeps a pending link's box while taking it out of the
  // accessibility tree, `inert` blocks pointer and keyboard interaction, and
  // the click handlers below stay unwired until validation resolves.
  const pendingLinkProps = {
    className: isValidationPending ? "invisible" : undefined,
    inert: isValidationPending,
    "aria-hidden": isValidationPending || undefined,
  };

  return (
    <>
      <div className={NOTIFICATIONS_PANEL_HEADER_CLASS}>
        <Button
          variant="ghost"
          iconOnly={<ChevronLeft />}
          onClick={onBack}
          aria-label={t("notificationsBellDetail.back")}
        />
        <Typography
          variant="body-medium-default"
          as="h2"
          className="min-w-0 flex-1 truncate text-[var(--content-default)]"
        >
          {resolveFeedItemTitle(item)}
        </Typography>

        {/*
          Status actions ride in the header as icon-only buttons, the
          arrangement and labelling the Activity panel's mobile nav bar uses.
          The pair holds its own width opposite the back control, leaving the
          title the rest of the row to truncate into rather than pushing the
          header onto a second line.
        */}
        <div className="flex shrink-0 items-center gap-[var(--app-spacing-xs)]">
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

      {/*
        A fixed frame rather than a cap: a short notification leaves empty
        space below it and a long one scrolls inside, so the panel is the same
        size whichever notification is open. The `max-height` is measured
        against the viewport, never the content, so it clamps the frame on a
        screen too short to seat it without ever letting the notification's
        own length move it.
      */}
      <div
        data-testid="notifications-bell-detail-content"
        style={{ height: contentHeight, maxHeight: contentMaxHeight }}
        className="overflow-y-auto px-[var(--app-spacing-md)]"
      >
        {item.detailPanel?.kind === "toolPermission" ? (
          <HomeToolPermissionCard item={item} />
        ) : (
          <HomeGenericDetail item={item} className={BODY_LEADING_CLASS} />
        )}

        {/*
          The assistant's own offers on this notification, so they sit with the
          content rather than in the footer of navigation links. Each one starts
          a fresh conversation, so all of them go inert together while one is in
          flight and no second conversation can be opened by a double click. A
          label longer than the panel truncates instead of widening the row.
        */}
        {actions.length > 0 ? (
          <div
            data-testid="notifications-bell-detail-actions"
            className="mt-[var(--app-spacing-md)] flex flex-wrap gap-[var(--app-spacing-sm)]"
          >
            {actions.map((action) => (
              <Button
                key={action.id}
                variant="outlined"
                className="max-w-full"
                disabled={isActionPending}
                onClick={() => onTriggerAction(action.id)}
              >
                <Typography
                  variant="body-medium-default"
                  className="min-w-0 truncate"
                >
                  {action.label}
                </Typography>
              </Button>
            ))}
          </div>
        ) : null}
      </div>

      {/*
        A pinned strip closing the frame: the timestamp on the left, the links
        out on the right. Every notification has a timestamp, so the strip is
        always there. Both links can be offered at once, and they wrap under
        the timestamp in the narrowest bottom sheets rather than overflowing.
      */}
      <div
        data-testid="notifications-bell-detail-footer"
        className="mt-[var(--app-spacing-sm)] flex flex-wrap items-center justify-between gap-[var(--app-spacing-sm)] border-t border-[var(--border-base)] pt-[var(--app-spacing-sm)]"
      >
        <Typography
          variant="body-small-lighter"
          className="min-w-0 truncate text-[var(--content-tertiary)]"
          title={formatFullLocalDate(item.timestamp)}
        >
          {formatCompactLocalDate(item.timestamp)}
        </Typography>

        {/* `ml-auto` keeps the links against the right edge on the second row
            too, once a narrow sheet has wrapped them off the timestamp's. */}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-[var(--app-spacing-sm)]">
          {entityLinks.map((link) => (
            <Button
              key={link.kind}
              variant="outlined"
              leftIcon={<link.icon className="size-4" />}
              onClick={
                isValidationPending ? undefined : () => onNavigate(link.to)
              }
              {...pendingLinkProps}
            >
              {t(link.labelKey)}
            </Button>
          ))}
          {linkedConversationId ? (
            <Button
              variant="primary"
              onClick={
                isValidationPending
                  ? undefined
                  : () => onGoToConversation(linkedConversationId)
              }
              {...pendingLinkProps}
            >
              {t("actions.goToConversation")}
            </Button>
          ) : null}
        </div>
      </div>
    </>
  );
}
