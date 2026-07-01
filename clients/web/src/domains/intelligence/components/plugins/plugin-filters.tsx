import {
    ArrowDownToLine,
    Check,
    CheckCircle,
    Filter,
    LayoutGrid,
    Loader2,
    Power,
    PowerOff,
    Search,
} from "lucide-react";
import { type ChangeEvent, type ReactNode, useState } from "react";

import type { PluginFilter } from "@/domains/intelligence/plugins/types";
import { resolveCategoryIcon } from "@/domains/intelligence/skills/category-icon-map";
import type { CategoryInfo } from "@/domains/intelligence/skills/use-skill-categories";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { BottomSheet, Button, Input, PanelItem, Popover } from "@vellumai/design-library";

interface FilterOption {
  value: PluginFilter;
  label: string;
  icon: typeof LayoutGrid;
}

const ALL_FILTER: FilterOption = { value: "all", label: "All", icon: LayoutGrid };
const AVAILABLE_FILTER: FilterOption = {
  value: "available",
  label: "Available",
  icon: ArrowDownToLine,
};

/**
 * Status options for the filter. Active/Off narrow installed rows by
 * enablement, so they only make sense when the daemon supports toggling —
 * without it there's no active/off distinction, so fall back to All / Available.
 */
function statusFilters(pluginToggleSupported: boolean): FilterOption[] {
  if (!pluginToggleSupported) return [ALL_FILTER, AVAILABLE_FILTER];
  return [
    ALL_FILTER,
    { value: "active", label: "Active", icon: Power },
    { value: "off", label: "Off", icon: PowerOff },
    AVAILABLE_FILTER,
  ];
}

interface FilterBarProps {
  search: string;
  onSearchChange: (value: string) => void;
  filter: PluginFilter;
  onFilterChange: (f: PluginFilter) => void;
  isSearching?: boolean;
  /** Available plugin categories — surfaced inside the mobile filter sheet. */
  categories: CategoryInfo[];
  /** Currently selected category slug, or `null` for "All". */
  category: string | null;
  onCategoryChange: (category: string | null) => void;
  /** Per-category result counts keyed by slug. */
  counts: Record<string, number>;
  totalCount: number;
  showCounts: boolean;
  /** Gates the Active/Off status options on daemon enable/disable support. */
  pluginToggleSupported: boolean;
}

export function FilterBar({
  search,
  onSearchChange,
  filter,
  onFilterChange,
  isSearching = false,
  categories,
  category,
  onCategoryChange,
  counts,
  totalCount,
  showCounts,
  pluginToggleSupported,
}: FilterBarProps) {
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    onSearchChange(e.target.value);
  };

  return (
    <div className="flex items-center gap-3">
      <Input
        type="search"
        value={search}
        onChange={handleChange}
        placeholder="Search plugins"
        aria-label="Search plugins"
        leftIcon={<Search className="h-4 w-4" aria-hidden />}
        rightIcon={
          isSearching ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : undefined
        }
        fullWidth
        wrapperClassName="flex-1"
      />

      <FilterControl
        filter={filter}
        onFilterChange={onFilterChange}
        categories={categories}
        category={category}
        onCategoryChange={onCategoryChange}
        counts={counts}
        totalCount={totalCount}
        showCounts={showCounts}
        pluginToggleSupported={pluginToggleSupported}
      />
    </div>
  );
}

interface FilterControlProps {
  filter: PluginFilter;
  onFilterChange: (v: PluginFilter) => void;
  categories: CategoryInfo[];
  category: string | null;
  onCategoryChange: (category: string | null) => void;
  counts: Record<string, number>;
  totalCount: number;
  showCounts: boolean;
  pluginToggleSupported: boolean;
}

/**
 * Filter affordance for the Plugins page. On mobile the outlined button opens a
 * bottom sheet exposing Status AND Categories (the category sidebar is
 * desktop-only, so the sheet is mobile's sole category surface). On desktop the
 * same button opens a compact Status popover; the always-visible sidebar owns
 * category selection there.
 */
function FilterControl(props: FilterControlProps) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  const trigger = (
    <Button
      type="button"
      variant="outlined"
      iconOnly={<Filter aria-hidden />}
      aria-label="Filter plugins"
      aria-haspopup={isMobile ? "dialog" : "listbox"}
      aria-expanded={open}
      tintColor="var(--primary-base)"
    />
  );

  if (isMobile) {
    return (
      <FilterSheet {...props} open={open} onOpenChange={setOpen} trigger={trigger} />
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Content
        align="end"
        sideOffset={4}
        className="w-44 overflow-hidden p-0"
      >
        <ul role="listbox">
          <FilterGroup
            label="Status"
            options={statusFilters(props.pluginToggleSupported)}
            selected={props.filter}
            onSelect={(v) => {
              props.onFilterChange(v);
              setOpen(false);
            }}
          />
        </ul>
      </Popover.Content>
    </Popover.Root>
  );
}

interface FilterSheetProps extends FilterControlProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
}

/**
 * Mobile bottom sheet. Status and Categories are independent axes that both
 * stay applied, so selecting a row updates the results live behind the sheet
 * without closing it — the user dials in both, then taps Done (or outside) to
 * dismiss. The Categories section only renders when the daemon exposes the
 * taxonomy (mirrors the desktop sidebar's capability gate).
 */
function FilterSheet({
  filter,
  onFilterChange,
  categories,
  category,
  onCategoryChange,
  counts,
  totalCount,
  showCounts,
  pluginToggleSupported,
  open,
  onOpenChange,
  trigger,
}: FilterSheetProps) {
  const sortedCategories = [...categories].sort((a, b) =>
    a.label.localeCompare(b.label),
  );

  return (
    <BottomSheet.Root open={open} onOpenChange={onOpenChange}>
      <BottomSheet.Trigger asChild>{trigger}</BottomSheet.Trigger>
      <BottomSheet.Content className="max-h-[85dvh]" aria-describedby={undefined}>
        <div
          aria-hidden
          className="mx-auto mb-3 h-1 w-9 shrink-0 rounded-full bg-[var(--border-element)]"
        />
        <BottomSheet.Header>
          <BottomSheet.Title>Filters</BottomSheet.Title>
        </BottomSheet.Header>
        <BottomSheet.Body className="flex flex-col gap-3 pt-2">
          <SheetSection label="Status">
            {statusFilters(pluginToggleSupported).map((option) => (
              <FilterRow
                key={option.value}
                icon={option.icon}
                label={option.label}
                active={filter === option.value}
                onSelect={() => onFilterChange(option.value)}
              />
            ))}
          </SheetSection>

          {categories.length > 0 && (
            <SheetSection label="Categories">
              <FilterRow
                icon={LayoutGrid}
                label="All"
                active={category === null}
                badge={showCounts ? totalCount : undefined}
                onSelect={() => onCategoryChange(null)}
              />
              {sortedCategories.map((cat) => (
                <FilterRow
                  key={cat.slug}
                  icon={resolveCategoryIcon(cat.icon) ?? LayoutGrid}
                  label={cat.label}
                  active={category === cat.slug}
                  badge={showCounts ? (counts[cat.slug] ?? 0) : undefined}
                  onSelect={() => onCategoryChange(cat.slug)}
                />
              ))}
            </SheetSection>
          )}
        </BottomSheet.Body>
        <BottomSheet.Footer>
          <Button
            type="button"
            variant="primary"
            fullWidth
            onClick={() => onOpenChange(false)}
          >
            Done
          </Button>
        </BottomSheet.Footer>
      </BottomSheet.Content>
    </BottomSheet.Root>
  );
}

function SheetSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div
        className="px-2 pb-1 text-body-small-default uppercase tracking-wide"
        style={{ color: "var(--content-tertiary)" }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

/**
 * One selectable row inside the filter sheet. `badge` carries a result count
 * (categories); the trailing check marks the active row on the count-less
 * Status axis where the branded highlight alone is easy to miss.
 */
function FilterRow({
  icon,
  label,
  active,
  badge,
  onSelect,
}: {
  icon: typeof LayoutGrid;
  label: string;
  active: boolean;
  badge?: ReactNode;
  onSelect: () => void;
}) {
  return (
    <PanelItem
      icon={icon}
      label={label}
      active={active}
      activeVariant="branded"
      badge={badge}
      trailingAction={
        active && badge == null ? (
          <Check className="h-4 w-4 text-[var(--primary-base)]" aria-hidden />
        ) : undefined
      }
      onSelect={onSelect}
    />
  );
}

function FilterGroup({
  label,
  options,
  selected,
  onSelect,
}: {
  label: string;
  options: FilterOption[];
  selected: PluginFilter;
  onSelect: (v: PluginFilter) => void;
}) {
  return (
    <li>
      <div
        className="px-3 pb-1 pt-2 text-body-small-default uppercase tracking-wide"
        style={{ color: "var(--content-tertiary)" }}
      >
        {label}
      </div>
      <ul>
        {options.map((option) => {
          const Icon = option.icon;
          const isSelected = selected === option.value;
          return (
            <li key={option.value}>
              <button
                type="button"
                onClick={() => onSelect(option.value)}
                role="option"
                aria-selected={isSelected}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-body-medium-lighter transition-colors hover:bg-[var(--surface-hover)]"
                style={{
                  color: isSelected
                    ? "var(--primary-base)"
                    : "var(--content-default)",
                }}
              >
                <Icon className="h-4 w-4" aria-hidden />
                <span className="flex-1">{option.label}</span>
                {isSelected && <CheckCircle className="h-3.5 w-3.5" aria-hidden />}
              </button>
            </li>
          );
        })}
      </ul>
    </li>
  );
}
