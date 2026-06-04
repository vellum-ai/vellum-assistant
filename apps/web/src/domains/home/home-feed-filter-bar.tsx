import { Bell, Clock, List, Mail, Settings, ShieldCheck } from "lucide-react";
import { type ComponentType, type SVGProps } from "react";

import type { FeedItemCategory } from "@vellumai/assistant-api";
import { Typography, cn } from "@vellumai/design-library";

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

function FilterPill({
  icon: Icon,
  iconColor,
  bgColor,
  isSelected,
  label,
  onClick,
}: {
  icon: LucideIcon;
  iconColor: string;
  bgColor: string;
  isSelected: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={isSelected}
      onClick={onClick}
      className={cn(
        "flex shrink-0 cursor-pointer items-center justify-center rounded-full transition-opacity",
        isSelected ? "opacity-100" : "opacity-50 hover:opacity-75",
      )}
      style={{
        width: 26,
        height: 26,
        backgroundColor: bgColor,
      }}
    >
      <Icon
        width={12}
        height={12}
        style={{ color: iconColor }}
        aria-hidden="true"
      />
    </button>
  );
}

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

  return (
    <div className="flex items-center gap-[var(--app-spacing-sm)] overflow-x-auto">
      <Typography
        variant="body-small-default"
        className="shrink-0 text-[var(--content-tertiary)]"
      >
        Filter:
      </Typography>

      <FilterPill
        icon={List}
        iconColor="var(--content-secondary)"
        bgColor="var(--surface-overlay)"
        isSelected={activeFilter === null}
        label="All"
        onClick={() => onFilterChange(null)}
      />

      {presentCategories.map((category) => {
        const style = CATEGORY_STYLES[category];
        return (
          <FilterPill
            key={category}
            icon={style.icon}
            iconColor={style.strong}
            bgColor={style.weak}
            isSelected={activeFilter === category}
            label={category.charAt(0).toUpperCase() + category.slice(1)}
            onClick={() => onFilterChange(category)}
          />
        );
      })}
    </div>
  );
}
