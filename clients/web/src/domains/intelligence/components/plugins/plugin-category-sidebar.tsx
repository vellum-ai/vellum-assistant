import { LayoutGrid } from "lucide-react";

import { resolveCategoryIcon } from "@/domains/intelligence/skills/category-icon-map";
import type { CategoryInfo } from "@/domains/intelligence/skills/use-skill-categories";
import { Button } from "@vellumai/design-library";

interface PluginCategorySidebarProps {
  selected: string | null;
  onSelect: (slug: string | null) => void;
  counts: Record<string, number>;
  totalCount: number;
  showCounts: boolean;
  categories: CategoryInfo[];
}

/**
 * Desktop category rail for the Plugins tab. Categories are the SHARED Skills
 * taxonomy (same hook, same icon map) — uncategorized plugins bucket into the
 * real `"system"` category row, so there is no free-form merge here.
 */
export function PluginCategorySidebar({
  selected,
  onSelect,
  counts,
  totalCount,
  showCounts,
  categories,
}: PluginCategorySidebarProps) {
  const sortedCategories = [...categories].sort((a, b) =>
    a.label.localeCompare(b.label),
  );

  return (
    <nav className="flex flex-col gap-1" aria-label="Plugin categories">
      <CategoryRow
        icon={LayoutGrid}
        label="All"
        count={totalCount}
        isActive={selected === null}
        showCount={showCounts}
        onClick={() => onSelect(null)}
      />
      {sortedCategories.map((cat) => {
        const Icon = resolveCategoryIcon(cat.icon) ?? LayoutGrid;
        return (
          <CategoryRow
            key={cat.slug}
            icon={Icon}
            label={cat.label}
            count={counts[cat.slug] ?? 0}
            isActive={selected === cat.slug}
            showCount={showCounts}
            onClick={() => onSelect(cat.slug)}
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
