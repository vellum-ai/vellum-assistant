import { Bell, ChevronRight } from "lucide-react";
import { useState } from "react";

import { PageEmptyState } from "@/components/page-empty-state";

import type {
    FeedItem,
    FeedItemCategory,
    FeedItemStatus,
} from "@vellumai/assistant-api";
import { Collapsible, Typography } from "@vellumai/design-library";
import { HomeFeedFilterBar } from "./home-feed-filter-bar";
import { HomeFeedSourceFilter } from "./home-feed-source-filter";
import { HomeRecapRow } from "./home-recap-row";
import type { FeedTimeGroup } from "./utils";
import {
    excludeHighUrgency,
    filterByCategory,
    filterBySource,
    getPresentCategories,
    getPresentSources,
    groupByTime,
    sortFeedItems,
} from "./utils";

const TIME_GROUP_LABELS: Record<FeedTimeGroup, string> = {
  today: "Today",
  yesterday: "Yesterday",
  older: "Older",
};

const READ_ARCHIVE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A notification the user has already read (seen or acted on — not "new")
 * and that's older than ~7 days. These are folded into a collapsed accordion
 * so the live feed stays focused on recent and unread activity.
 */
function isArchivedRead(item: FeedItem, now: number): boolean {
  if (item.status === "new" || item.status === "dismissed") return false;
  return now - new Date(item.createdAt).getTime() > READ_ARCHIVE_AGE_MS;
}

export interface HomeFeedListProps {
  items: FeedItem[];
  selectedItemId?: string | null;
  validConversationIds?: Set<string>;
  onSelectItem: (item: FeedItem) => void;
  onDismissItem: (itemId: string) => void;
  onRestoreItem: (itemId: string) => void;
  onToggleRead?: (itemId: string, newStatus: FeedItemStatus) => void;
  onGoToThread?: (conversationId: string) => void;
  /** Controlled open-states for the archive accordions (lifted so they survive
   * the section remount when the detail drawer opens). */
  archivedOpen?: boolean;
  onArchivedOpenChange?: (open: boolean) => void;
  dismissedOpen?: boolean;
  onDismissedOpenChange?: (open: boolean) => void;
}

export function HomeFeedList({
  items,
  selectedItemId,
  validConversationIds,
  onSelectItem,
  onDismissItem,
  onRestoreItem,
  onToggleRead,
  onGoToThread,
  archivedOpen,
  onArchivedOpenChange,
  dismissedOpen,
  onDismissedOpenChange,
}: HomeFeedListProps) {
  const [activeFilter, setActiveFilter] = useState<FeedItemCategory | null>(
    null,
  );
  const [activeSource, setActiveSource] = useState<string | null>(null);
  // Stable per-mount "now" for the read-archive cutoff — calling Date.now()
  // during render is impure (and flagged by react-hooks/purity).
  const [now] = useState(() => Date.now());

  const visible = items.filter((item) => item.status !== "dismissed");
  const eligible = excludeHighUrgency(visible);

  // Split off already-read items older than ~7 days into a collapsed archive,
  // keeping the live feed (and its filters) focused on recent rows.
  const recent = eligible.filter((item) => !isArchivedRead(item, now));
  const archivedRead = sortFeedItems(
    eligible.filter((item) => isArchivedRead(item, now)),
  );

  const presentCategories = getPresentCategories(recent);
  const presentSources = getPresentSources(recent);
  const effectiveFilter =
    activeFilter && presentCategories.includes(activeFilter)
      ? activeFilter
      : null;
  const effectiveSource =
    activeSource && presentSources.some((s) => s.key === activeSource)
      ? activeSource
      : null;

  // Reset stale active filters during render when their value disappears
  // from the feed. Without this, a previously-selected filter would
  // silently re-activate if it later reappeared (e.g. a new notification
  // of that category/source arrives). React bails out when the next state
  // equals the current, so this is safe and preferable to a
  // synchronization Effect.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  if (activeFilter !== effectiveFilter) {
    setActiveFilter(effectiveFilter);
  }
  if (activeSource !== effectiveSource) {
    setActiveSource(effectiveSource);
  }

  const filtered = filterBySource(
    filterByCategory(recent, effectiveFilter),
    effectiveSource,
  );
  const sorted = sortFeedItems(filtered);
  const grouped = groupByTime(sorted);

  const dismissed = items
    .filter((item) => item.status === "dismissed")
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

  return (
    <div className="flex flex-col gap-[var(--app-spacing-lg)]">
      {(presentCategories.length > 1 || presentSources.length > 1) && (
        <div className="flex flex-wrap items-center gap-[var(--app-spacing-sm)]">
          <HomeFeedFilterBar
            categories={presentCategories}
            activeFilter={effectiveFilter}
            onFilterChange={setActiveFilter}
          />
          <HomeFeedSourceFilter
            sources={presentSources}
            activeSource={effectiveSource}
            onSourceChange={setActiveSource}
          />
        </div>
      )}

      {grouped.size === 0 ? (
        effectiveFilter || effectiveSource ? (
          <Typography
            variant="body-medium-lighter"
            className="py-[var(--app-spacing-xl)] text-center text-[var(--content-disabled)]"
          >
            No items match the selected filter.
          </Typography>
        ) : (
          <PageEmptyState
            icon={Bell}
            title="No notifications yet"
            description="Updates and activity from your assistant will appear here."
          />
        )
      ) : (
        [...grouped.entries()].map(([group, groupItems]) => (
          <section
            key={group}
            className="flex flex-col gap-[var(--app-spacing-md)]"
          >
            <Typography
              variant="body-small-default"
              as="h3"
              className="text-[var(--content-tertiary)]"
            >
              {TIME_GROUP_LABELS[group]}
            </Typography>

            <div className="flex flex-col gap-[var(--app-spacing-xs)]">
              {groupItems.map((item) => (
                <HomeRecapRow
                  key={item.id}
                  item={item}
                  isActive={item.id === selectedItemId}
                  validConversationIds={validConversationIds}
                  onSelect={onSelectItem}
                  onDismiss={onDismissItem}
                  onToggleRead={onToggleRead}
                  onGoToThread={onGoToThread}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {archivedRead.length > 0 && (
        <Collapsible.Root
          type="single"
          collapsible
          value={archivedOpen ? "archived-read" : ""}
          onValueChange={(v) => onArchivedOpenChange?.(v === "archived-read")}
        >
          <Collapsible.Item value="archived-read">
            <Collapsible.Trigger className="group gap-[var(--app-spacing-xs)] text-body-small-default text-[var(--content-tertiary)]">
              <ChevronRight
                size={14}
                aria-hidden
                className="shrink-0 transition-transform group-data-[state=open]:rotate-90"
              />
              <span>Earlier ({archivedRead.length})</span>
            </Collapsible.Trigger>
            <Collapsible.Content>
              <div className="flex flex-col gap-[var(--app-spacing-xs)] pt-[var(--app-spacing-sm)]">
                {archivedRead.map((item) => (
                  <HomeRecapRow
                    key={item.id}
                    item={item}
                    isActive={item.id === selectedItemId}
                    validConversationIds={validConversationIds}
                    onSelect={onSelectItem}
                    onDismiss={onDismissItem}
                    onToggleRead={onToggleRead}
                    onGoToThread={onGoToThread}
                  />
                ))}
              </div>
            </Collapsible.Content>
          </Collapsible.Item>
        </Collapsible.Root>
      )}

      {dismissed.length > 0 && (
        <Collapsible.Root
          type="single"
          collapsible
          value={dismissedOpen ? "dismissed" : ""}
          onValueChange={(v) => onDismissedOpenChange?.(v === "dismissed")}
        >
          <Collapsible.Item value="dismissed">
            <Collapsible.Trigger className="group gap-[var(--app-spacing-xs)] text-body-small-default text-[var(--content-tertiary)]">
              <ChevronRight
                size={14}
                aria-hidden
                className="shrink-0 transition-transform group-data-[state=open]:rotate-90"
              />
              <span>Dismissed ({dismissed.length})</span>
            </Collapsible.Trigger>
            <Collapsible.Content>
              <div className="flex flex-col gap-[var(--app-spacing-xs)] pt-[var(--app-spacing-sm)]">
                {dismissed.map((item) => (
                  <HomeRecapRow
                    key={item.id}
                    item={item}
                    onSelect={onSelectItem}
                    onDismiss={onRestoreItem}
                    trailingAction="restore"
                  />
                ))}
              </div>
            </Collapsible.Content>
          </Collapsible.Item>
        </Collapsible.Root>
      )}
    </div>
  );
}
