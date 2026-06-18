import { Bell, ChevronRight } from "lucide-react";
import { useState } from "react";

import { HomeEmptyState } from "./components/home-empty-state";

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

export interface HomeFeedListProps {
  items: FeedItem[];
  selectedItemId?: string | null;
  validConversationIds?: Set<string>;
  onSelectItem: (item: FeedItem) => void;
  onDismissItem: (itemId: string) => void;
  onRestoreItem: (itemId: string) => void;
  onToggleRead?: (itemId: string, newStatus: FeedItemStatus) => void;
  onGoToThread?: (conversationId: string) => void;
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
}: HomeFeedListProps) {
  const [activeFilter, setActiveFilter] = useState<FeedItemCategory | null>(
    null,
  );
  const [activeSource, setActiveSource] = useState<string | null>(null);

  const visible = items.filter((item) => item.status !== "dismissed");
  const eligible = excludeHighUrgency(visible);
  const presentCategories = getPresentCategories(eligible);
  const presentSources = getPresentSources(eligible);
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
    filterByCategory(eligible, effectiveFilter),
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
          <HomeEmptyState
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

      {dismissed.length > 0 && (
        <Collapsible.Root type="single" collapsible>
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
