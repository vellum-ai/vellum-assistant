import { useState } from "react";

import { Typography } from "@vellum/design-library";
import { HomeFeedFilterBar } from "./home-feed-filter-bar.js";
import { HomeRecapRow } from "./home-recap-row.js";
import {
  excludeHighUrgency,
  filterByCategory,
  getPresentCategories,
  groupByTime,
  sortFeedItems,
} from "./utils/feed-utils.js";
import type { FeedItem, FeedItemCategory, FeedTimeGroup } from "./types.js";

const TIME_GROUP_LABELS: Record<FeedTimeGroup, string> = {
  today: "Today",
  yesterday: "Yesterday",
  older: "Older",
};

export interface HomeFeedListProps {
  items: FeedItem[];
  onSelectItem: (item: FeedItem) => void;
  onDismissItem: (itemId: string) => void;
}

export function HomeFeedList({
  items,
  onSelectItem,
  onDismissItem,
}: HomeFeedListProps) {
  const [activeFilter, setActiveFilter] = useState<FeedItemCategory | null>(
    null,
  );

  const visible = items.filter((item) => item.status !== "dismissed");
  const eligible = excludeHighUrgency(visible);
  const presentCategories = getPresentCategories(eligible);
  const filtered = filterByCategory(eligible, activeFilter);
  const sorted = sortFeedItems(filtered);
  const grouped = groupByTime(sorted);

  return (
    <div className="flex flex-col gap-[var(--app-spacing-lg)]">
      <HomeFeedFilterBar
        categories={presentCategories}
        activeFilter={activeFilter}
        onFilterChange={setActiveFilter}
      />

      {grouped.size === 0 ? (
        <Typography
          variant="body-medium-lighter"
          className="py-[var(--app-spacing-xl)] text-center text-[var(--content-disabled)]"
        >
          {activeFilter
            ? "No items match the selected filter."
            : "No items to show."}
        </Typography>
      ) : (
        [...grouped.entries()].map(([group, groupItems]) => (
          <section
            key={group}
            className="flex flex-col gap-[var(--app-spacing-xs)]"
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
                  onSelect={onSelectItem}
                  onDismiss={onDismissItem}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
