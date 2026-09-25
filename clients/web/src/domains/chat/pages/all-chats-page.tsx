/**
 * All chats: the whole conversation history on one page, banded by date and
 * narrowed by a chip row.
 *
 * Presentational. Everything it cannot know on its own arrives as a prop, so
 * a story renders exactly what ships. The row actions come through
 * {@link ConversationListContextValue}, the same channel the sidebar's rows
 * read, so this page's right-click menu is the sidebar's menu rather than a
 * second copy of it.
 *
 * Quiet by intent: muted band labels and compact unread/activity indicators.
 * The list is virtualized and pages on scroll, so the band
 * headings travel with their rows instead of sticking.
 */

import { ArrowRight, MoreHorizontal, RotateCcw, Search, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";

import {
  Button,
  ContextMenu,
  FilterChip,
  Input,
  PanelItem,
  Typography,
  VirtualList,
} from "@vellumai/design-library";
import { cn } from "@vellumai/design-library/utils/cn";

import { usePublishPageSurface } from "@/stores/page-surface-store";
import {
  ConversationListProvider,
  useConversationListContext,
  type ConversationListContextValue,
} from "@/domains/chat/components/conversation-list-context";
import {
  buildMenuProps,
  skipNestedControls,
} from "@/domains/chat/components/conversation-row";
import {
  ConversationActionsSheet,
  ConversationActionsMenu,
  renderConversationMenuItems,
} from "@/domains/chat/components/conversation-actions-menu";
import { conversationDoneLabels } from "@/utils/done-labels";
import { useLongPressSheet } from "@/hooks/use-long-press-sheet";
import {
  filterAllChats,
  isDoneConversation,
  allChatsFilterKey,
  allChatsFilters,
  searchAllChats,
  type AllChatsFilter,
} from "@/domains/chat/utils/all-chats-filters";
import { formatLocale, useTranslation, type TFunction } from "@/i18n";
import type {
  Conversation,
  ConversationGroup,
} from "@/types/conversation-types";
import {
  bucketByDate,
  formatBucketedTime,
  type DateBucketId,
} from "@/utils/bucket-by-date";
import { ChannelIcon, getChannelLabel } from "@/utils/channel-presentation";
import { useDisplayConversationTitle } from "@/utils/conversation-title";
import { usePointerCoarse } from "@/utils/pointer";
import { useHoverCapable } from "@/hooks/use-hover-affordance";

export interface AllChatsPageProps {
  /** Every row loaded so far, unfiltered and recency-ordered. */
  conversations: Conversation[];
  /** Custom groups, for the chip labels. */
  groups: ConversationGroup[];
  /** The selected chip. The URL owns it, so the page never changes it alone. */
  filter: AllChatsFilter;
  onFilterChange: (filter: AllChatsFilter) => void;
  /** Row actions and the open handler, shared with the sidebar's rows. */
  listContext: ConversationListContextValue;
  hasMore: boolean;
  onLoadMore: () => void;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onClose?: () => void;
  renderActivity?: (conversation: Conversation) => ReactNode;
  onRowMount?: (conversationId: string) => () => void;
  /** The instant the date bands are measured against. Defaults to now. */
  now?: Date;
}

/** One rendered line: a band heading, or a conversation under it. */
type AllChatsListItem =
  | { kind: "header"; key: string; label: string }
  | { kind: "row"; key: string; conversation: Conversation };

/**
 * Spelled out rather than built from the band's kind: the catalog guard finds
 * a key by its literal in source, so an interpolated key reads as four
 * unreferenced entries and is deleted the next time the catalogs are swept.
 */
const BAND_LABEL_KEYS = {
  today: "allChatsPage.band.today",
  yesterday: "allChatsPage.band.yesterday",
  previous7Days: "allChatsPage.band.previous7Days",
  previous30Days: "allChatsPage.band.previous30Days",
} as const;

function bandLabel(
  id: DateBucketId,
  t: TFunction<"chat">,
  locale: string,
): string {
  if (id.kind === "month") {
    return new Date(id.year, id.month, 1).toLocaleDateString(locale, {
      month: "long",
      year: "numeric",
    });
  }
  return t(BAND_LABEL_KEYS[id.kind]);
}

/**
 * The instant a row is filed under: its last message, falling back to when it
 * was created, which is what a chat with no messages yet has.
 */
function rowTime(conversation: Conversation): number | undefined {
  return conversation.lastMessageAt ?? conversation.createdAt;
}

/**
 * The row's timestamp. Metadata, so it is
 * drawn at the size and tone the rest of the page gives secondary text rather
 * than at the title's weight: this page is a long column of near-identical
 * rows, and the title is the only thing in one worth reading first.
 */
export const ROW_META_CLASSES =
  "whitespace-nowrap tabular-nums text-body-small-lighter text-[color:var(--content-tertiary)]";

/**
 * Right-aligns both occupants of the row's shared trailing cell.
 *
 * `PanelItem` stacks the badge and the trailing action in one `CrossfadeStack`
 * so they trade places without moving the title, and that cell centres what it
 * holds. Centring is right for the sidebar, whose badge is a status dot about
 * the width of its ellipsis. Here the badge is a timestamp several times wider
 * than the check that replaces it, so a centred check floats inboard by half
 * the difference and lands somewhere new on every row. Stretching both
 * occupants and ending their content pins the check's right edge to the
 * timestamp's, on every row.
 *
 * Applied from the call site through `data-slot`, which is the design
 * library's stated way to restyle a part from outside without widening a
 * component's API (see `packages/design-library/AGENTS.md`). The descendant
 * selector outweighs the badge's own `justify-center`, so this does not
 * depend on utility ordering.
 */
export const META_SLOT_CLASSES = [
  "[&_[data-slot=crossfade-stack]>*]:w-full",
  "[&_[data-slot=crossfade-stack]>*]:justify-end",
].join(" ");

/**
 * Local midnight of the current day, advancing when the day turns, so a page
 * left open overnight re-bands its rows instead of keeping yesterday's chats
 * under Today with clock-only timestamps.
 *
 * One timeout aimed at the next local midnight rather than a poll: the
 * boundary is known exactly, and a backgrounded tab whose timer fires late
 * simply re-bands late and schedules the next one from the time it woke.
 */
function useLocalDayStart(): number {
  const [dayStart, setDayStart] = useState(() =>
    new Date().setHours(0, 0, 0, 0),
  );
  useEffect(() => {
    const nextMidnight = new Date();
    nextMidnight.setHours(24, 0, 0, 0);
    const timer = setTimeout(
      () => setDayStart(new Date().setHours(0, 0, 0, 0)),
      /* At least a second, so a clock moved onto the boundary cannot schedule
         a zero-delay timer that re-fires in a loop. */
      Math.max(1_000, nextMidnight.getTime() - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [dayStart]);
  return dayStart;
}

/**
 * Keep asking for pages while the loaded window holds nothing the current
 * chip and search leave standing.
 *
 * The window is one global recency page and the narrowing is client-side, so
 * an empty view here says nothing about the pages behind it. An
 * `IntersectionObserver` cannot drive this: the sentinel it watches never
 * leaves the viewport in an empty view, so it reports one intersection and
 * never another however much data arrives. Re-running on the loaded row count
 * is what asks again. It stops when a match appears, when the server reports
 * no more pages, or when a page adds no rows at all.
 */
export function useBackfillUntilMatch({
  enabled,
  loadedCount,
  onLoadMore,
}: {
  enabled: boolean;
  loadedCount: number;
  onLoadMore: () => void;
}): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    onLoadMore();
  }, [enabled, loadedCount, onLoadMore]);
}

/** Exported for its own test; the page is the only thing that renders it. */
export function AllChatsRow({
  conversation,
  now,
  activity,
  onMount,
}: {
  conversation: Conversation;
  now: Date;
  activity?: ReactNode;
  onMount?: (conversationId: string) => () => void;
}) {
  const { t } = useTranslation("chat");
  const displayTitle = useDisplayConversationTitle();
  const ctx = useConversationListContext();
  const done = isDoneConversation(conversation);
  const title = displayTitle(conversation.title);
  const activityDescriptionId = useId();
  const unreadDescriptionId = useId();
  const isTouch = usePointerCoarse();
  const canHover = useHoverCapable();
  useEffect(
    () => onMount?.(conversation.conversationId),
    [onMount, conversation.conversationId],
  );
  const timestamp = rowTime(conversation);
  /* Measured against the same `now` the bands are, so the label and the
     heading above it are two readings of one decision. */
  const when =
    timestamp === undefined
      ? ""
      : formatBucketedTime(timestamp, now, formatLocale());
  /* This page exists only with `sidebar-done` on, so its menus never say
     "Archive": the label set is pinned to the done wording rather than read
     off the flag, which is what keeps a story of the page honest too. */
  const doneLabels = conversationDoneLabels(t, true);
  const toggleLabel = done ? doneLabels.unarchive : doneLabels.archive;

  const longPress = useLongPressSheet({ shouldSkip: skipNestedControls });
  const menuProps = buildMenuProps(ctx, conversation);
  const canToggleDone =
    !menuProps.isReadonly && Boolean(done ? ctx.onUnarchive : ctx.onArchive);
  const toggleDone = useCallback(() => {
    if (done) {
      ctx.onUnarchive?.(conversation);
    } else {
      ctx.onArchive?.(conversation);
    }
  }, [ctx, conversation, done]);

  const row = (
    <PanelItem
      label={
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "min-w-0 truncate",
              done && "text-[var(--content-tertiary)] line-through",
            )}
          >
            {title}
          </span>
          {conversation.hasUnseenLatestAssistantMessage && (
            <span
              id={unreadDescriptionId}
              className="size-1.5 shrink-0 rounded-full bg-[var(--system-mid-strong)]"
            >
              <span className="sr-only">{t("allChatsPage.unread")}</span>
            </span>
          )}
          <span
            id={activityDescriptionId}
            className="ml-auto flex shrink-0 items-center"
          >
            {activity}
          </span>
        </span>
      }
      aria-label={done ? t("allChatsPage.doneLabel", { title }) : title}
      aria-describedby={[
        conversation.hasUnseenLatestAssistantMessage && unreadDescriptionId,
        activityDescriptionId,
      ]
        .filter(Boolean)
        .join(" ")}
      leadingSlot={
        <ChannelIcon
          channelId={conversation.originChannel}
          className={cn(
            "size-5 shrink-0",
            done
              ? "text-[color:var(--content-disabled)]"
              : "text-[color:var(--content-tertiary)]",
          )}
        />
      }
      badge={<span className={ROW_META_CLASSES}>{when}</span>}
      badgeBare
      onSelect={() => ctx.onSelect(conversation.conversationId)}
      trailingAction={
        <span
          className="flex items-center"
          onKeyDown={(event) => event.stopPropagation()}
        >
          {canHover && canToggleDone && (
            <Button
              variant="ghost"
              size="compact"
              iconOnly={
                done ? (
                  <doneLabels.unarchiveIcon aria-hidden />
                ) : (
                  <doneLabels.archiveIcon aria-hidden />
                )
              }
              aria-label={toggleLabel}
              tooltip={toggleLabel}
              onClick={toggleDone}
            />
          )}
          {canHover && (
            <Button
              variant="ghost"
              size="compact"
              iconOnly={<ArrowRight aria-hidden />}
              aria-label={t("allChatsPage.openChat")}
              tooltip={t("allChatsPage.openChat")}
              onClick={() => ctx.onSelect(conversation.conversationId)}
            />
          )}
          <ConversationActionsMenu
            {...menuProps}
            doneLabels={doneLabels}
            side="bottom"
            align="end"
            trigger={
              <Button
                variant="ghost"
                size="compact"
                className="[@media(pointer:coarse)]:size-11"
                iconOnly={<MoreHorizontal aria-hidden />}
                aria-label={t("conversationActions.triggerAriaLabel")}
              />
            }
          />
        </span>
      }
      className={cn(
        "min-h-11 px-2 py-2 max-md:py-2! text-[var(--content-default)]",
        META_SLOT_CLASSES,
      )}
      title={
        timestamp === undefined
          ? undefined
          : new Date(timestamp).toLocaleString(formatLocale())
      }
    />
  );

  /* Touch: a long press opens the actions sheet instead of Radix's
     pointer-positioned context popover, matching the sidebar's rows. The
     wrapper adds no layout box and the sheet is its sibling, which is what
     `useLongPressSheet` requires. */
  if (isTouch) {
    return (
      <>
        <div {...longPress.wrapperProps}>{row}</div>
        <ConversationActionsSheet
          {...menuProps}
          doneLabels={doneLabels}
          open={longPress.open}
          onOpenChange={longPress.onOpenChange}
        />
      </>
    );
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger>{row}</ContextMenu.Trigger>
      <ContextMenu.Content onClick={(event) => event.stopPropagation()}>
        {renderConversationMenuItems({
          Primitive: ContextMenu,
          t,
          doneLabels,
          ...menuProps,
        })}
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}

export function AllChatsPage({
  conversations,
  groups,
  filter,
  onFilterChange,
  listContext,
  hasMore,
  onLoadMore,
  isLoading,
  isError,
  onRetry,
  onClose,
  renderActivity,
  onRowMount,
  now,
}: AllChatsPageProps) {
  usePublishPageSurface("var(--surface-base)");
  const { t } = useTranslation("chat");
  const displayTitle = useDisplayConversationTitle();
  const [searchText, setSearchText] = useState("");

  const chips = useMemo(
    () => allChatsFilters(conversations, groups, filter),
    [conversations, groups, filter],
  );

  const rows = useMemo(
    () =>
      searchAllChats(
        filterAllChats(conversations, filter),
        searchText,
        displayTitle,
      ),
    [conversations, filter, searchText, displayTitle],
  );

  /* One reference instant for every band and every row label in a render, so
     two rows read minutes apart cannot land on opposite sides of a midnight
     that moved between them. Local midnight rather than the current time:
     nothing here asks for anything finer than the calendar day, and pinning
     it to the day is what lets the value stay stable until the day turns. */
  const dayStart = useLocalDayStart();
  const bandedAt = useMemo(() => now ?? new Date(dayStart), [now, dayStart]);
  const locale = formatLocale();

  const items = useMemo((): AllChatsListItem[] => {
    const bands = bucketByDate(rows, rowTime, bandedAt);
    return bands.flatMap((band): AllChatsListItem[] => [
      {
        kind: "header",
        key: `header:${band.key}`,
        label: bandLabel(band.id, t, locale),
      },
      ...band.items.map(
        (conversation): AllChatsListItem => ({
          kind: "row",
          key: conversation.conversationId,
          conversation,
        }),
      ),
    ]);
  }, [rows, bandedAt, t, locale]);

  const groupName = useCallback(
    (groupId: string) => groups.find((g) => g.id === groupId)?.name ?? groupId,
    [groups],
  );

  const chipLabel = useCallback(
    (chip: AllChatsFilter): string => {
      switch (chip.kind) {
        case "all":
          return t("allChatsPage.chip.all");
        case "done":
          return t("allChatsPage.chip.done");
        case "background":
          return t("allChatsPage.chip.background");
        case "channel":
          return getChannelLabel(chip.channelId);
        case "group":
          return groupName(chip.groupId);
      }
    },
    [t, groupName],
  );

  const renderItem = useCallback(
    (_index: number, item: AllChatsListItem) =>
      item.kind === "header" ? (
        <h2 className="px-2 pt-6 pb-1 text-body-small-lighter text-[color:var(--content-tertiary)]">
          {item.label}
        </h2>
      ) : (
        <AllChatsRow
          conversation={item.conversation}
          now={bandedAt}
          activity={renderActivity?.(item.conversation)}
          onMount={item.conversation.draft ? undefined : onRowMount}
        />
      ),
    [bandedAt, renderActivity, onRowMount],
  );

  const endReached = useCallback(() => {
    if (hasMore) {
      onLoadMore();
    }
  }, [hasMore, onLoadMore]);

  /* An empty view is only the answer once the history runs out, so the page
     keeps pulling while the loaded window leaves nothing standing. */
  useBackfillUntilMatch({
    enabled: items.length === 0 && hasMore && !isLoading && !isError,
    loadedCount: conversations.length,
    onLoadMore,
  });

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col px-3 pt-5 md:px-0 md:pt-6"
      aria-label={t("allChatsPage.title")}
    >
      {/* The desktop shell ends 16px from the window edge. Center against the
          window while clamping the column inside the available main pane. */}
      <div className="flex min-h-0 w-full max-w-[600px] flex-1 flex-col self-center md:self-start md:ml-[max(0px,calc(100%_-_50vw_-_284px))]">
        <div className="mb-8 flex shrink-0 items-center justify-between gap-3">
          <Typography
            as="h1"
            variant="title-large"
            className="text-[var(--content-default)] [--font-sans:var(--font-serif)] [--text-title-large-size:32px] [--text-title-large-weight:400]"
          >
            {t("allChatsPage.title")}
          </Typography>
          {onClose && (
            <Button
              variant="ghost"
              size="compact"
              className="[@media(pointer:coarse)]:size-11"
              iconOnly={<X aria-hidden />}
              aria-label={t("allChatsPage.close")}
              tooltip={t("allChatsPage.close")}
              onClick={onClose}
            />
          )}
        </div>

        <Input
          fullWidth
          wrapperClassName="shrink-0"
          type="text"
          placeholder={t("allChatsPage.searchPlaceholder")}
          aria-label={t("allChatsPage.searchPlaceholder")}
          value={searchText}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            setSearchText(event.target.value)
          }
          leftIcon={<Search size={16} />}
        />

        <div
          role="group"
          aria-label={t("allChatsPage.filterAria")}
          className="mt-4 mb-2 flex shrink-0 gap-2 overflow-x-auto pb-1"
        >
          {chips.map((chip) => {
            const key = allChatsFilterKey(chip);
            return (
              <FilterChip
                key={key}
                selected={key === allChatsFilterKey(filter)}
                className={cn(
                  "border-[var(--border-subtle)] [--text-body-medium-default-weight:400]",
                  key === allChatsFilterKey(filter)
                    ? "bg-[var(--surface-active)] text-[var(--content-default)]"
                    : "bg-transparent",
                )}
                onClick={() => onFilterChange(chip)}
              >
                {chipLabel(chip)}
              </FilterChip>
            );
          })}
        </div>

        <div className="min-h-0 flex-1">
          <AllChatsBody
            items={items}
            isLoading={isLoading}
            isError={isError}
            onRetry={onRetry}
            searchText={searchText}
            listContext={listContext}
            renderItem={renderItem}
            hasMore={hasMore}
            endReached={endReached}
          />
        </div>
      </div>
    </section>
  );
}

/** The page's spinner, shared by the first read and the search for a match. */
function AllChatsSpinner({ label }: { label: string }) {
  return (
    <div
      className="size-6 animate-spin rounded-full border-2 border-[var(--border-base)] border-t-[var(--primary-base)]"
      role="status"
      aria-label={label}
    />
  );
}

/**
 * The list region and the states that replace it. Split out so each branch's
 * copy is explicit and the page above stays the layout alone.
 */
function AllChatsBody({
  items,
  isLoading,
  isError,
  onRetry,
  searchText,
  listContext,
  renderItem,
  hasMore,
  endReached,
}: {
  items: AllChatsListItem[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  searchText: string;
  listContext: ConversationListContextValue;
  renderItem: (index: number, item: AllChatsListItem) => ReactNode;
  hasMore: boolean;
  endReached: () => void;
}) {
  const { t } = useTranslation("chat");

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <AllChatsSpinner label={t("allChatsPage.loading")} />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-4">
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          {t("allChatsPage.loadError")}
        </p>
        <Button variant="outlined" onClick={onRetry}>
          <RotateCcw className="size-4" aria-hidden />
          {t("allChatsPage.retry")}
        </Button>
      </div>
    );
  }

  if (items.length === 0) {
    /* The chips and the search run over the loaded window, while the window
       itself is one global recency page, so a view with no match here may
       still have plenty further back. `useBackfillUntilMatch` in the page is
       pulling those pages; until it runs out this is a search in progress,
       not an empty history. */
    if (hasMore) {
      return (
        <div className="flex h-full items-center justify-center">
          <AllChatsSpinner label={t("allChatsPage.loading")} />
        </div>
      );
    }
    return (
      <div className="flex h-full flex-col items-center justify-center px-4">
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          {searchText.trim()
            ? t("allChatsPage.noMatches", { query: searchText.trim() })
            : t("allChatsPage.empty")}
        </p>
      </div>
    );
  }

  return (
    <ConversationListProvider value={listContext}>
      <VirtualList
        items={items}
        itemContent={renderItem}
        computeItemKey={(_index, item) => item.key}
        endReached={endReached}
        className="h-full bg-transparent"
      />
    </ConversationListProvider>
  );
}
