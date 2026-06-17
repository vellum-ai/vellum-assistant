import { Bell, Clock, List, Mail, Settings, ShieldCheck } from "lucide-react";
import { type ComponentType, type SVGProps } from "react";

import type { FeedItemCategory } from "@vellumai/assistant-api";
import {
  SegmentControl,
  type SegmentControlItem,
} from "@vellumai/design-library";

type LucideIcon = ComponentType<SVGProps<SVGSVGElement>>;

interface CategoryStyle {
  icon: LucideIcon;
  strong: string;
  weak: string;
}

export const CATEGORY_STYLES: Record<FeedItemCategory, CategoryStyle> = {
  security: {
    icon: ShieldCheck,
    strong: "var(--feed-nudge-strong)",
    weak: "var(--feed-nudge-weak)",
  },
  email: {
    icon: Mail,
    strong: "var(--feed-digest-strong)",
    weak: "var(--feed-digest-weak)",
  },
  scheduling: {
    icon: Clock,
    strong: "var(--feed-thread-strong)",
    weak: "var(--feed-thread-weak)",
  },
  background: {
    icon: Settings,
    strong: "var(--system-info-strong)",
    weak: "var(--system-info-weak)",
  },
  system: {
    icon: Bell,
    strong: "var(--feed-digest-strong)",
    weak: "var(--feed-digest-weak)",
  },
};

export const CATEGORY_ORDER: FeedItemCategory[] = [
  "security",
  "email",
  "scheduling",
  "background",
  "system",
];

const ALL_FILTER = "all";
type FilterValue = FeedItemCategory | typeof ALL_FILTER;

export interface HomeFeedFilterBarProps {
  categories: FeedItemCategory[];
  activeFilter: FeedItemCategory | null;
  onFilterChange: (category: FeedItemCategory | null) => void;
}

export function HomeFeedFilterBar({
  categories,
  activeFilter,
  onFilterChange,
}: HomeFeedFilterBarProps) {
  const presentCategories = CATEGORY_ORDER.filter((c) =>
    categories.includes(c),
  );

  if (presentCategories.length <= 1) return null;

  const items: SegmentControlItem<FilterValue>[] = [
    { value: ALL_FILTER, label: "All", icon: <List className="h-4 w-4" /> },
    ...presentCategories.map((category) => {
      const Icon = CATEGORY_STYLES[category].icon;
      return {
        value: category,
        label: category.charAt(0).toUpperCase() + category.slice(1),
        icon: <Icon className="h-4 w-4" />,
      };
    }),
  ];

  return (
    <SegmentControl<FilterValue>
      ariaLabel="Filter notifications"
      iconOnly
      value={activeFilter ?? ALL_FILTER}
      onChange={(next) => onFilterChange(next === ALL_FILTER ? null : next)}
      items={items}
      className="self-start"
    />
  );
}
