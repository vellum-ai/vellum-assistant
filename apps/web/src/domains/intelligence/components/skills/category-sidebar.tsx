import { LayoutGrid } from "lucide-react";

import { Button } from "@vellum/design-library";
import {
  CATEGORY_DISPLAY_NAMES,
  CATEGORY_ICONS,
  SKILL_CATEGORIES,
} from "@/domains/intelligence/skills/category";
import type { SkillCategory } from "@/domains/intelligence/skills/types";

interface CategorySidebarProps {
  selected: SkillCategory | null;
  onSelect: (category: SkillCategory | null) => void;
  counts: Record<string, number>;
  totalCount: number;
  showCounts: boolean;
}

export function CategorySidebar({
  selected,
  onSelect,
  counts,
  totalCount,
  showCounts,
}: CategorySidebarProps) {
  const sortedCategories = [...SKILL_CATEGORIES].sort((a, b) =>
    CATEGORY_DISPLAY_NAMES[a].localeCompare(CATEGORY_DISPLAY_NAMES[b]),
  );

  return (
    <nav className="flex flex-col gap-1" aria-label="Skill categories">
      <CategoryRow
        icon={LayoutGrid}
        label="All"
        count={totalCount}
        isActive={selected === null}
        showCount={showCounts}
        onClick={() => onSelect(null)}
      />
      {sortedCategories.map((category) => {
        const Icon = CATEGORY_ICONS[category];
        return (
          <CategoryRow
            key={category}
            icon={Icon}
            label={CATEGORY_DISPLAY_NAMES[category]}
            count={counts[category] ?? 0}
            isActive={selected === category}
            showCount={showCounts}
            onClick={() => onSelect(category)}
          />
        );
      })}
    </nav>
  );
}

interface CategoryRowProps {
  icon: typeof LayoutGrid;
  label: string;
  count: number;
  isActive: boolean;
  showCount: boolean;
  onClick: () => void;
}

function CategoryRow({
  icon: Icon,
  label,
  count,
  isActive,
  showCount,
  onClick,
}: CategoryRowProps) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      aria-pressed={isActive}
      className="h-auto justify-between gap-3 rounded-lg border-0 bg-transparent px-3 py-2 text-left hover:bg-[var(--ghost-hover)]"
      style={{
        backgroundColor: isActive ? "var(--surface-active)" : undefined,
        color: isActive
          ? "var(--content-default)"
          : "var(--content-secondary)",
      }}
    >
      <span className="flex items-center gap-2.5">
        <Icon className="h-4 w-4 shrink-0" aria-hidden />
        <span className="text-body-medium-default">{label}</span>
      </span>
      {showCount && (
        <span
          className="text-body-small-default"
          style={{ color: "var(--content-tertiary)" }}
        >
          {count}
        </span>
      )}
    </Button>
  );
}
