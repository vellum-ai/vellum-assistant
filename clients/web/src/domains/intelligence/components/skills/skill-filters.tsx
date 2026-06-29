import {
    ArrowDownToLine,
    Box,
    Brain,
    Check,
    CheckCircle,
    Filter,
    Globe,
    LayoutGrid,
    Loader2,
    Search,
    Terminal,
    User,
} from "lucide-react";
import {
    type ChangeEvent,
    type Dispatch,
    type ReactNode,
    type SetStateAction,
    useState,
} from "react";

import { resolveCategoryIcon } from "@/domains/intelligence/skills/category-icon-map";
import type { SkillFilter } from "@/domains/intelligence/skills/types";
import type { CategoryInfo } from "@/domains/intelligence/skills/use-skill-categories";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { BottomSheet, Button, Input, PanelItem, Popover } from "@vellumai/design-library";

interface FilterOption {
  value: SkillFilter;
  label: string;
  icon: typeof LayoutGrid;
}

const ALL_FILTER: FilterOption = { value: "all", label: "All", icon: LayoutGrid };

const STATUS_FILTERS: FilterOption[] = [
  ALL_FILTER,
  { value: "installed", label: "Installed", icon: CheckCircle },
  { value: "available", label: "Available", icon: ArrowDownToLine },
];

const ORIGIN_FILTERS: FilterOption[] = [
  { value: "vellum", label: "Vellum", icon: Box },
  { value: "clawhub", label: "Clawhub", icon: Globe },
  { value: "skillssh", label: "skills.sh", icon: Terminal },
  { value: "custom", label: "Custom", icon: User },
  { value: "assistant-memory", label: "Assistant's Memory", icon: Brain },
];

interface FilterBarProps {
  search: string;
  onSearchChange: Dispatch<SetStateAction<string>>;
  filter: SkillFilter;
  onFilterChange: (f: SkillFilter) => void;
  isSearching: boolean;
  /** Available skill categories — surfaced inside the mobile filter sheet. */
  categories: CategoryInfo[];
  /** Currently selected category slug, or `null` for "All". */
  category: string | null;
  onCategoryChange: (category: string | null) => void;
  /** Per-category result counts keyed by slug. */
  counts: Record<string, number>;
  /** Total result count across all categories (the "All" row badge). */
  totalCount: number;
  /** Hide counts while a search is in flight (they'd be stale mid-query). */
  showCounts: boolean;
}

export function FilterBar({
  search,
  onSearchChange,
  filter,
  onFilterChange,
  isSearching,
  categories,
  category,
  onCategoryChange,
  counts,
  totalCount,
  showCounts,
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
        placeholder="Search skills"
        aria-label="Search skills"
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
      />
    </div>
  );
}

interface FilterControlProps {
  filter: SkillFilter;
  onFilterChange: (v: SkillFilter) => void;
  categories: CategoryInfo[];
  category: string | null;
  onCategoryChange: (category: string | null) => void;
  counts: Record<string, number>;
  totalCount: number;
  showCounts: boolean;
}

/**
 * Filter affordance for the Skills page. On mobile the outlined filter button
 * opens a bottom sheet exposing Status, Source, AND Categories (the category
 * sidebar is desktop-only, so the sheet is mobile's sole category surface). On
 * desktop the same button opens a compact popover with Status + Source; the
 * always-visible sidebar owns category selection there.
 */
function FilterControl(props: FilterControlProps) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  const trigger = (
    <Button
      type="button"
      variant="outlined"
      iconOnly={<Filter aria-hidden />}
      aria-label="Filter skills"
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
            options={STATUS_FILTERS}
            selected={props.filter}
            onSelect={(v) => {
              props.onFilterChange(v);
              setOpen(false);
            }}
          />
          <div
            className="border-t"
            style={{ borderColor: "var(--border-base)" }}
          />
          <FilterGroup
            label="Source"
            options={ORIGIN_FILTERS}
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
 * Mobile bottom sheet. Status/Source and Categories are independent axes that
 * both stay applied, so selecting a row updates the results live behind the
 * sheet without closing it — the user dials in both, then taps Done (or
 * outside) to dismiss.
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
            {STATUS_FILTERS.map((option) => (
              <FilterRow
                key={option.value}
                icon={option.icon}
                label={option.label}
                active={filter === option.value}
                onSelect={() => onFilterChange(option.value)}
              />
            ))}
          </SheetSection>

          <SheetSection label="Source">
            {ORIGIN_FILTERS.map((option) => (
              <FilterRow
                key={option.value}
                icon={option.icon}
                label={option.label}
                active={filter === option.value}
                onSelect={() => onFilterChange(option.value)}
              />
            ))}
          </SheetSection>

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

/** Section grouping inside the mobile filter sheet. */
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
 * Status/Source axes where the branded highlight alone is easy to miss.
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
  selected: SkillFilter;
  onSelect: (v: SkillFilter) => void;
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
