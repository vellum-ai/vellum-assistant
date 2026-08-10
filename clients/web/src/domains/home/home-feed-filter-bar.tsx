import { Bell, Clock, List, Mail, Settings, ShieldCheck } from "lucide-react";
import { type ComponentType, type SVGProps } from "react";

import { useTranslation } from "@/i18n";
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
  /**
   * Written out per category rather than built from the wire value, so a
   * category added without its copy fails to compile and the key stays
   * greppable for the orphan check in `catalogs.test.ts`.
   */
  labelKey: `category.${FeedItemCategory}`;
}

export const CATEGORY_STYLES: Record<FeedItemCategory, CategoryStyle> = {
  security: {
    icon: ShieldCheck,
    strong: "var(--feed-nudge-strong)",
    weak: "var(--feed-nudge-weak)",
    labelKey: "category.security",
  },
  email: {
    icon: Mail,
    strong: "var(--feed-digest-strong)",
    weak: "var(--feed-digest-weak)",
    labelKey: "category.email",
  },
  scheduling: {
    icon: Clock,
    strong: "var(--feed-thread-strong)",
    weak: "var(--feed-thread-weak)",
    labelKey: "category.scheduling",
  },
  background: {
    icon: Settings,
    strong: "var(--system-info-strong)",
    weak: "var(--system-info-weak)",
    labelKey: "category.background",
  },
  system: {
    icon: Bell,
    strong: "var(--feed-digest-strong)",
    weak: "var(--feed-digest-weak)",
    labelKey: "category.system",
  },
};

/** Resolves a category to its style, falling back to `system`. */
export function resolveCategoryStyle(
  category?: FeedItemCategory,
): CategoryStyle {
  if (category && CATEGORY_STYLES[category]) {
    return CATEGORY_STYLES[category];
  }
  return CATEGORY_STYLES.system;
}

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
  const { t } = useTranslation("home");
  const presentCategories = CATEGORY_ORDER.filter((c) =>
    categories.includes(c),
  );

  if (presentCategories.length <= 1) {
    return null;
  }

  const items: SegmentControlItem<FilterValue>[] = [
    {
      value: ALL_FILTER,
      label: t("category.all"),
      icon: <List className="h-4 w-4" />,
    },
    ...presentCategories.map((category) => {
      const { icon: Icon, labelKey } = CATEGORY_STYLES[category];
      return {
        value: category,
        label: t(labelKey),
        icon: <Icon className="h-4 w-4" />,
      };
    }),
  ];

  return (
    <SegmentControl<FilterValue>
      ariaLabel={t("homeFeedFilterBar.ariaLabel")}
      value={activeFilter ?? ALL_FILTER}
      onChange={(next) => onFilterChange(next === ALL_FILTER ? null : next)}
      items={items}
      // Labeled mode defaults to full width with flex-1 segments; keep it
      // compact (sized to its content) by overriding both.
      className="self-start !w-auto [&>*]:!flex-none"
    />
  );
}
