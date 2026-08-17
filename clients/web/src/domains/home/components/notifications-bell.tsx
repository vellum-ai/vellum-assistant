import { Bell } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import {
  useBackgroundConversationListQuery,
  useConversationListQuery,
  useScheduledConversationListQuery,
} from "@/hooks/conversation-queries";
import { useTouchMobile } from "@/hooks/use-touch-mobile";
import { useTranslation } from "@/i18n";
import { useSupportsBulkFeedStatus } from "@/lib/backwards-compat/bulk-feed-status";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { mergeConversationLists } from "@/utils/conversation-cache";
import { navigateToConversation } from "@/utils/conversation-navigation";
import type { FeedItem, FeedItemStatus } from "@vellumai/assistant-api";
import {
  BottomSheet,
  Button,
  Popover,
  Tooltip,
  Typography,
} from "@vellumai/design-library";
import { toast } from "@vellumai/design-library/components/toast";

import { HomeRecapRow } from "../home-recap-row";
import { useFeedItemEntityLinks } from "../hooks/use-feed-item-entity-links";
import { useHomeFeedQuery } from "../hooks/use-home-feed-query";
import {
  clearAllArgs,
  getVisibleFeedItems,
  markAllReadArgs,
  resolveFeedItemTitle,
  sortFeedItems,
} from "../utils";
import {
  NOTIFICATIONS_PANEL_HEADER_CLASS,
  NotificationsBellDetail,
} from "./notifications-bell-detail";

/**
 * Router state read by `HomePageRoute`: arriving at the Activity page with a
 * `feedItemId` opens that item's detail drawer.
 */
export interface ActivityLocationState {
  feedItemId?: string;
}

// The height budget the panel's content region is drawn against: five compact
// cards plus the four 8px gaps between them. A compact card is 73px tall: 2px
// borders, 16px padding, a 32px title line (sized by the h-8 hover actions that
// share it with the timestamp), a 2px gap, and a 21px preview line.
// 5 * 73 + 4 * 8 = 397. The list takes it as a cap, so a short feed draws a
// short panel and older notifications stay reachable by scrolling. The detail
// takes it as a fixed height, so every notification renders in the same frame.
const PANEL_CONTENT_HEIGHT = "397px";

// Ceiling on that budget, so a viewport too short to seat it shrinks the
// content region instead of running the popover off the bottom edge. The
// popover path is taken on width alone (`useIsMobile` is a 767px width query),
// and a phone in landscape is around 844x390: wide enough for the popover,
// 390px tall.
//
// The subtracted allowance is the chrome the content region shares the
// viewport with, on the 8px spacing grid: 48px of top bar (16px of padding
// over a 32px icon button) plus the popover's 8px sideOffset, 16px of popover
// padding, a 40px header row (a 32px control row plus its 8px margin), a 49px
// footer strip (8px margin, a 1px rule, 8px padding, a 32px button row), and
// 8px of clearance at the bottom edge. 48 + 8 + 16 + 40 + 49 + 8 = 169,
// rounded up to 176. The clamp therefore only engages below a 573px viewport,
// leaving every ordinary desktop window on the budget exactly.
const PANEL_VIEWPORT_MAX_HEIGHT = "calc(100dvh - 176px)";

// The list caps rather than fixes, so its one `max-height` has to carry both
// terms; the detail splits them across `height` and `max-height`, which is the
// same minimum.
const PANEL_LIST_MAX_HEIGHT = `min(${PANEL_CONTENT_HEIGHT}, ${PANEL_VIEWPORT_MAX_HEIGHT})`;

// The same budget on a bottom sheet, where the content region is measured
// against the viewport rather than the popover. No viewport ceiling of its
// own: the sheet is capped at 85dvh and its body scrolls, so an oversized
// frame scrolls inside the sheet rather than escaping the viewport. The
// popover has no such scrolling ancestor, which is why only it needs one.
const MOBILE_PANEL_CONTENT_HEIGHT = "60dvh";

/**
 * Notification bell for the top nav: a ghost icon button with an unread dot
 * that opens the latest notifications in a popover (desktop) or bottom sheet
 * (mobile) — the same split the sidebar preferences menu uses. Rows reuse
 * `HomeRecapRow`, so mark-read and dismiss work inline; selecting one swaps
 * the panel to that notification's detail, which a back control returns from.
 *
 * Owned by the home domain (it renders the home feed), so the chat layout
 * can't import it directly (cross-domain); `routes.tsx` injects it into
 * `ChatLayout` as `topBarAccessory` instead. Self-contained: reads the
 * active assistant from the resolved-assistants store — same source as
 * ChatLayout — so the injection site needs no wiring.
 */
export function NotificationsBell() {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const isTouchMobile = useTouchMobile();
  const { t } = useTranslation("home");
  const navigate = useNavigate();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const feedQuery = useHomeFeedQuery(assistantId);
  const supportsBulkStatus = useSupportsBulkFeedStatus();

  // Memoized: the bell lives in the persistent top bar and re-renders with
  // every layout update, so the filter + sort must only re-run when the feed
  // data itself changes.
  const items = feedQuery.data?.items;
  const visibleItems = useMemo(
    () => sortFeedItems(getVisibleFeedItems(items ?? [])),
    [items],
  );
  const hasUnread = visibleItems.some((item) => item.status === "new");

  // Tracked by id, not by value: the feed is the one owner of an item's
  // status, so the detail follows a mark-read without a second copy to
  // reconcile. Resolved against the whole feed rather than the visible slice,
  // because the detail's own status actions can take the item out of that
  // slice: an item dismissed from another surface keeps its detail open and
  // offering Restore, and only an item the feed drops entirely closes it.
  // Dismissing from here returns to the list explicitly, in `handleDismiss`.
  const selectedItem = selectedItemId
    ? ((items ?? []).find((item) => item.id === selectedItemId) ?? null)
    : null;
  const isDetailOpen = selectedItem !== null;

  // A notification can point at a conversation that has since been deleted, so
  // the detail's "Go to Conversation" link is checked against the same three
  // lists the Activity page merges. They load only while a detail is open: the
  // bell renders in the top bar on every route, and the list view has no use
  // for the ids. Disabled, these stay subscribed to the caches without
  // fetching, so the foreground list the chat layout already loaded is read
  // for free and opening a detail costs the background and scheduled lists at
  // most.
  const {
    conversations: foregroundConversations,
    isPending: isForegroundPending,
  } = useConversationListQuery(assistantId, isDetailOpen);
  const {
    conversations: backgroundConversations,
    isPending: isBackgroundPending,
  } = useBackgroundConversationListQuery(assistantId, isDetailOpen);
  const {
    conversations: scheduledConversations,
    isPending: isScheduledPending,
  } = useScheduledConversationListQuery(assistantId, isDetailOpen);
  const validConversationIds = useMemo(
    () =>
      new Set(
        mergeConversationLists(
          foregroundConversations,
          backgroundConversations,
          scheduledConversations,
        ).map((conversation) => conversation.conversationId),
      ),
    [foregroundConversations, backgroundConversations, scheduledConversations],
  );
  const areConversationListsPending =
    isForegroundPending || isBackgroundPending || isScheduledPending;

  // A notification also links back to what it is about: the schedule that
  // produced a scheduled run, the skill a background pass rewrote. Either may
  // since have been deleted, so the resolver checks each against the list that
  // owns it (shared options, shared cache entries). Same gate as the
  // conversation lists: the list view has no use for those ids.
  const { links: entityLinks, isPending: areEntityLinksPending } =
    useFeedItemEntityLinks(selectedItem, assistantId, isDetailOpen);

  // The list unmounts while the detail is open, so its scroll offset is parked
  // here and written back when the list mounts again.
  const listScrollTopRef = useRef(0);
  const restoreListScroll = useCallback((node: HTMLDivElement | null) => {
    if (node) {
      node.scrollTop = listScrollTopRef.current;
    }
  }, []);

  // Radix restores focus to the trigger when the popover closes, and Radix
  // Tooltip opens on focus unless that focus followed a pointerdown on the
  // trigger. A close driven by a pointer that is somewhere else (a click on a
  // panel control, or outside the panel) therefore lands focus on the bell
  // with the cursor away from it, opening the "Notifications" tooltip with no
  // pointerleave coming to dismiss it. Marks such a close so the focus
  // restore can be skipped for it.
  const closedByPointerRef = useRef(false);

  // Activation modality of the last interaction inside the panel. The panel's
  // controls close it from `onClick`, which fires for Enter and Space as well
  // as for a pointer, so the close handlers cannot infer a pointer on their
  // own. Keyboard closes keep the focus restore, which keyboard users need to
  // hold their place in the top bar.
  const isPointerInteractionRef = useRef(false);

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (open) {
      // A fresh close cycle: neither flag carries over from the last one.
      closedByPointerRef.current = false;
      isPointerInteractionRef.current = false;
    } else {
      // Reopening always lands on the list, at the top.
      setSelectedItemId(null);
      listScrollTopRef.current = 0;
    }
  };

  const closePanel = () => {
    closedByPointerRef.current = isPointerInteractionRef.current;
    handleOpenChange(false);
  };

  const handleSelectItem = (item: FeedItem) => {
    if (item.status === "new") {
      feedQuery.updateStatus.mutate({ itemId: item.id, status: "seen" });
    }
    setSelectedItemId(item.id);
  };

  const handleGoToConversation = (conversationId: string) => {
    closePanel();
    navigateToConversation(navigate, conversationId);
  };

  const handleNavigate = (to: string) => {
    closePanel();
    navigate(to);
  };

  const handleUpdateStatus = (itemId: string, status: FeedItemStatus) => {
    feedQuery.updateStatus.mutate({ itemId, status });
  };

  const handleDismiss = (itemId: string) => {
    feedQuery.updateStatus.mutate({ itemId, status: "dismissed" });
    // A dismissed item is gone from the list behind the detail, so the detail
    // has nothing left to return to. Closing it here rather than letting the
    // lookup drop out keeps the list from flickering back if the mutation
    // fails and the feed rolls the status back.
    setSelectedItemId(null);
  };

  // Guards the mutation rather than the button: `isPending` reaches the button
  // only on the next render, so a second click landing in the same tick would
  // still get through and open a second conversation.
  const isTriggeringActionRef = useRef(false);

  const handleTriggerAction = (actionId: string) => {
    if (!selectedItem || isTriggeringActionRef.current) {
      return;
    }
    isTriggeringActionRef.current = true;
    feedQuery.triggerAction.mutate(
      { itemId: selectedItem.id, actionId },
      {
        onSuccess: (data) => {
          closePanel();
          navigateToConversation(navigate, data.conversationId);
        },
        onError: () => {
          toast.error(t("notificationsBell.actionFailed"));
        },
        onSettled: () => {
          isTriggeringActionRef.current = false;
        },
      },
    );
  };

  const handleMarkAllRead = () => {
    feedQuery.markAll.mutate(markAllReadArgs(visibleItems));
  };

  const handleClearAll = () => {
    feedQuery.markAll.mutate(clearAllArgs(visibleItems));
  };

  // No `tooltip` prop on the Button: it would wrap the button in a Tooltip
  // component, breaking the popover/sheet Trigger's `asChild` prop merge.
  // Desktop nests Tooltip *around* the Trigger instead (the
  // CollapsedGroupIcon pattern); mobile is touch, so no tooltip.
  const trigger = (
    <Button
      variant="ghost"
      iconOnly={
        <span className="relative flex" aria-hidden>
          <Bell />
          {hasUnread ? (
            // Same amber dot as the unread rows inside (HomeRecapRow), but
            // top-right (the BellDot arrangement) and ringed in the color of
            // the surface behind it so the ring reads as a gap carved out of
            // the bell outline: --surface-base under the desktop top bar,
            // --surface-lift inside the circular tap target that ghost
            // icon-only buttons grow on touch-mobile. The 2px ring eats into
            // the box (border-box), so size/offset grow by 2px each to keep
            // the 6px amber core in place.
            <span
              data-testid="notifications-bell-unread-dot"
              className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-[var(--surface-base)] bg-[var(--system-mid-strong)] touch-mobile:border-[var(--surface-lift)]"
            />
          ) : null}
        </span>
      }
      aria-label={
        hasUnread
          ? t("notificationsBell.ariaLabelUnread")
          : t("notificationsBell.ariaLabel")
      }
    />
  );

  const contentHeight = isTouchMobile
    ? MOBILE_PANEL_CONTENT_HEIGHT
    : PANEL_CONTENT_HEIGHT;
  const contentMaxHeight = isTouchMobile
    ? undefined
    : PANEL_VIEWPORT_MAX_HEIGHT;
  const listMaxHeight = isTouchMobile
    ? MOBILE_PANEL_CONTENT_HEIGHT
    : PANEL_LIST_MAX_HEIGHT;

  const list =
    visibleItems.length === 0 ? (
      <Typography
        variant="body-medium-lighter"
        className="px-[var(--app-spacing-lg)] py-[var(--app-spacing-xl)] text-center text-[var(--content-tertiary)]"
      >
        {feedQuery.isError
          ? t("notificationsBell.loadFailed")
          : t("notificationsBell.empty")}
      </Typography>
    ) : (
      <div
        ref={restoreListScroll}
        onScroll={(event) => {
          listScrollTopRef.current = event.currentTarget.scrollTop;
        }}
        style={{ maxHeight: listMaxHeight }}
        className="flex flex-col gap-[var(--app-spacing-sm)] overflow-y-auto"
      >
        {visibleItems.map((item) => (
          <HomeRecapRow
            key={item.id}
            item={item}
            density="compact"
            onSelect={handleSelectItem}
            onDismiss={(itemId) =>
              feedQuery.updateStatus.mutate({ itemId, status: "dismissed" })
            }
            onToggleRead={(itemId, status) =>
              feedQuery.updateStatus.mutate({ itemId, status })
            }
          />
        ))}
      </div>
    );

  // Keyed so the swap remounts the incoming view and replays its entrance.
  const panel = (
    <div
      key={selectedItem ? "detail" : "list"}
      className={`flex min-w-0 flex-col ${
        selectedItem
          ? "notifications-panel-detail-enter"
          : "notifications-panel-list-enter"
      }`}
    >
      {selectedItem ? (
        <NotificationsBellDetail
          item={selectedItem}
          contentHeight={contentHeight}
          contentMaxHeight={contentMaxHeight}
          validConversationIds={validConversationIds}
          areConversationListsPending={areConversationListsPending}
          entityLinks={entityLinks}
          areEntityLinksPending={areEntityLinksPending}
          isActionPending={feedQuery.triggerAction.isPending}
          onBack={() => setSelectedItemId(null)}
          onGoToConversation={handleGoToConversation}
          onNavigate={handleNavigate}
          onUpdateStatus={handleUpdateStatus}
          onDismiss={handleDismiss}
          onTriggerAction={handleTriggerAction}
        />
      ) : (
        <>
          <div
            className={`${NOTIFICATIONS_PANEL_HEADER_CLASS} pl-[var(--app-spacing-md)]`}
          >
            <Typography
              variant="body-medium-default"
              as="h2"
              className="text-[var(--content-default)]"
            >
              {t("notificationsBell.heading")}
            </Typography>
          </div>

          {list}

          {supportsBulkStatus && visibleItems.length > 0 ? (
            <div className="mt-[var(--app-spacing-sm)] flex items-center justify-end gap-[var(--app-spacing-sm)] border-t border-[var(--border-base)] pt-[var(--app-spacing-sm)]">
              {hasUnread ? (
                <Button
                  variant="ghost"
                  size="compact"
                  onClick={handleMarkAllRead}
                  disabled={feedQuery.markAll.isPending}
                >
                  {t("actions.markAllAsRead")}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="compact"
                onClick={handleClearAll}
                disabled={feedQuery.markAll.isPending}
              >
                {t("actions.clearAll")}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );

  if (isTouchMobile) {
    return (
      <BottomSheet.Root open={isOpen} onOpenChange={handleOpenChange}>
        <BottomSheet.Trigger asChild>{trigger}</BottomSheet.Trigger>
        <BottomSheet.Content className="max-h-[85dvh]">
          <BottomSheet.Header className="sr-only">
            <BottomSheet.Title>
              {selectedItem
                ? resolveFeedItemTitle(selectedItem)
                : t("notificationsBell.heading")}
            </BottomSheet.Title>
          </BottomSheet.Header>
          <BottomSheet.Body className="pt-0">{panel}</BottomSheet.Body>
        </BottomSheet.Content>
      </BottomSheet.Root>
    );
  }

  return (
    <Popover.Root open={isOpen} onOpenChange={handleOpenChange}>
      <Tooltip content={t("notificationsBell.ariaLabel")}>
        <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      </Tooltip>
      <Popover.Content
        side="bottom"
        align="end"
        sideOffset={8}
        tabIndex={-1}
        onOpenAutoFocus={(event) => {
          // Focus the panel itself so the first row doesn't light up (and
          // show its hover actions) before the user interacts.
          const content = event.currentTarget as HTMLElement | null;
          event.preventDefault();
          content?.focus();
        }}
        onPointerDownCapture={() => {
          isPointerInteractionRef.current = true;
        }}
        onKeyDownCapture={() => {
          isPointerInteractionRef.current = false;
        }}
        onPointerDownOutside={() => {
          closedByPointerRef.current = true;
        }}
        onCloseAutoFocus={(event) => {
          if (closedByPointerRef.current) {
            closedByPointerRef.current = false;
            event.preventDefault();
          }
        }}
        className="w-96 max-w-[calc(100vw-2rem)] rounded-lg p-2"
      >
        {panel}
      </Popover.Content>
    </Popover.Root>
  );
}
