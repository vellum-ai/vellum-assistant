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
  Puzzle,
  Search,
  Terminal,
  User,
  Zap,
} from "lucide-react";
import {
  type ChangeEvent,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useState,
} from "react";

import { resolveCategoryIcon } from "@/domains/intelligence/skills/category-icon-map";
import type { CategoryInfo } from "@/domains/intelligence/skills/use-skill-categories";
import type { SuperpowerFilter } from "@/domains/intelligence/superpowers/types";
import { useTouchMobile } from "@/hooks/use-touch-mobile";
import { useTranslation } from "@/i18n";
import {
  BottomSheet,
  Button,
  Input,
  PanelItem,
  Popover,
} from "@vellumai/design-library";

interface FilterOption {
  value: SuperpowerFilter;
  label: string;
  icon: typeof LayoutGrid;
}

type TranslateFilterLabel = (
  key:
    | "superpowersFilters.filterLabel.all"
    | "superpowersFilters.filterLabel.installed"
    | "superpowersFilters.filterLabel.available"
    | "superpowersFilters.filterLabel.skills"
    | "superpowersFilters.filterLabel.plugins"
    | "superpowersFilters.filterLabel.custom"
    | "superpowersFilters.filterLabel.assistantMemory",
) => string;

/** `vellum`, `clawhub`, and `skills.sh` are brand/product names, never translated. */
function filterLabel(value: SuperpowerFilter, t: TranslateFilterLabel): string {
  switch (value) {
    case "vellum":
      return "Vellum";
    case "clawhub":
      return "Clawhub";
    case "skillssh":
      return "skills.sh";
    case "all":
      return t("superpowersFilters.filterLabel.all");
    case "installed":
      return t("superpowersFilters.filterLabel.installed");
    case "available":
      return t("superpowersFilters.filterLabel.available");
    case "skills":
      return t("superpowersFilters.filterLabel.skills");
    case "plugins":
      return t("superpowersFilters.filterLabel.plugins");
    case "custom":
      return t("superpowersFilters.filterLabel.custom");
    case "assistant-memory":
      return t("superpowersFilters.filterLabel.assistantMemory");
  }
}

function useFilterOptions(): {
  statusFilters: FilterOption[];
  typeFilters: FilterOption[];
  originFilters: FilterOption[];
} {
  const { t } = useTranslation("intelligence");
  return {
    statusFilters: [
      { value: "all", label: filterLabel("all", t), icon: LayoutGrid },
      {
        value: "installed",
        label: filterLabel("installed", t),
        icon: CheckCircle,
      },
      {
        value: "available",
        label: filterLabel("available", t),
        icon: ArrowDownToLine,
      },
    ],
    typeFilters: [
      { value: "skills", label: filterLabel("skills", t), icon: Zap },
      { value: "plugins", label: filterLabel("plugins", t), icon: Puzzle },
    ],
    originFilters: [
      { value: "vellum", label: filterLabel("vellum", t), icon: Box },
      { value: "clawhub", label: filterLabel("clawhub", t), icon: Globe },
      { value: "skillssh", label: filterLabel("skillssh", t), icon: Terminal },
      { value: "custom", label: filterLabel("custom", t), icon: User },
      {
        value: "assistant-memory",
        label: filterLabel("assistant-memory", t),
        icon: Brain,
      },
    ],
  };
}

interface FilterBarProps {
  search: string;
  onSearchChange: Dispatch<SetStateAction<string>>;
  filter: SuperpowerFilter;
  onFilterChange: (f: SuperpowerFilter) => void;
  isSearching: boolean;
  /** Available categories, surfaced inside the filter sheet. */
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
  /**
   * Whether the connected assistant exposes the plugin surface. When it
   * doesn't, the list is skills-only, so the Type group is omitted.
   */
  pluginsSupported: boolean;
  /**
   * Whether this control owns category selection, which it does exactly when
   * the page's category rail is unmounted and categories have no other surface.
   */
  showCategories: boolean;
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
  pluginsSupported,
  showCategories,
}: FilterBarProps) {
  const { t } = useTranslation("intelligence");
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    onSearchChange(e.target.value);
  };

  return (
    <div className="flex items-center gap-3">
      <Input
        type="search"
        value={search}
        onChange={handleChange}
        placeholder={t("superpowersFilters.searchPlaceholder")}
        aria-label={t("superpowersFilters.searchAriaLabel")}
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
        pluginsSupported={pluginsSupported}
        showCategories={showCategories}
      />
    </div>
  );
}

interface FilterControlProps {
  filter: SuperpowerFilter;
  onFilterChange: (v: SuperpowerFilter) => void;
  categories: CategoryInfo[];
  category: string | null;
  onCategoryChange: (category: string | null) => void;
  counts: Record<string, number>;
  totalCount: number;
  showCounts: boolean;
  pluginsSupported: boolean;
  showCategories: boolean;
}

/**
 * Filter affordance for the My Superpowers page. On touch the outlined filter
 * button opens a bottom sheet; otherwise it opens a compact popover. Both
 * surfaces carry Status, Type, and Source, and both grow a Categories section
 * when the page's category rail is unmounted, so category selection is reachable
 * on exactly one surface at any viewport.
 */
function FilterControl(props: FilterControlProps) {
  const { t } = useTranslation("intelligence");
  const isTouchMobile = useTouchMobile();
  const [open, setOpen] = useState(false);
  const { statusFilters, typeFilters, originFilters } = useFilterOptions();

  const trigger = (
    <Button
      type="button"
      variant="outlined"
      iconOnly={<Filter aria-hidden />}
      aria-label={t("superpowersFilters.filterAriaLabel")}
      aria-haspopup={isTouchMobile ? "dialog" : "listbox"}
      aria-expanded={open}
      tintColor="var(--primary-base)"
    />
  );

  if (isTouchMobile) {
    return (
      <FilterSheet
        {...props}
        open={open}
        onOpenChange={setOpen}
        trigger={trigger}
      />
    );
  }

  const selectAndClose = (v: SuperpowerFilter) => {
    props.onFilterChange(v);
    setOpen(false);
  };

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
            label={t("superpowersFilters.statusLabel")}
            options={statusFilters}
            selected={props.filter}
            onSelect={selectAndClose}
          />
          {props.pluginsSupported && (
            <>
              <div
                className="border-t"
                style={{ borderColor: "var(--border-base)" }}
              />
              <FilterGroup
                label={t("superpowersFilters.typeLabel")}
                options={typeFilters}
                selected={props.filter}
                onSelect={selectAndClose}
              />
            </>
          )}
          <div
            className="border-t"
            style={{ borderColor: "var(--border-base)" }}
          />
          <FilterGroup
            label={t("superpowersFilters.sourceLabel")}
            options={originFilters}
            selected={props.filter}
            onSelect={selectAndClose}
          />
          {props.showCategories && (
            <>
              <div
                className="border-t"
                style={{ borderColor: "var(--border-base)" }}
              />
              <CategoryGroup
                categories={props.categories}
                category={props.category}
                counts={props.counts}
                totalCount={props.totalCount}
                showCounts={props.showCounts}
                allLabel={t("superpowersFilters.filterLabel.all")}
                categoriesLabel={t("superpowersFilters.categoriesLabel")}
                onSelect={(next) => {
                  props.onCategoryChange(next);
                  setOpen(false);
                }}
              />
            </>
          )}
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
 * Touch bottom sheet. Status/Type/Source and Categories are independent axes
 * that both stay applied, so selecting a row updates the results live behind
 * the sheet without closing it — the user dials in both, then taps Done (or
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
  pluginsSupported,
  showCategories,
  open,
  onOpenChange,
  trigger,
}: FilterSheetProps) {
  const { t } = useTranslation("intelligence");
  const { statusFilters, typeFilters, originFilters } = useFilterOptions();
  return (
    <BottomSheet.Root open={open} onOpenChange={onOpenChange}>
      <BottomSheet.Trigger asChild>{trigger}</BottomSheet.Trigger>
      <BottomSheet.Content
        className="max-h-[85dvh]"
        aria-describedby={undefined}
      >
        <div
          aria-hidden
          className="mx-auto mb-3 h-1 w-9 shrink-0 rounded-full bg-[var(--border-element)]"
        />
        <BottomSheet.Header>
          <BottomSheet.Title>
            {t("superpowersFilters.filtersTitle")}
          </BottomSheet.Title>
        </BottomSheet.Header>
        <BottomSheet.Body className="flex flex-col gap-3 pt-2">
          <SheetSection label={t("superpowersFilters.statusLabel")}>
            {statusFilters.map((option) => (
              <FilterRow
                key={option.value}
                icon={option.icon}
                label={option.label}
                active={filter === option.value}
                onSelect={() => onFilterChange(option.value)}
              />
            ))}
          </SheetSection>

          {pluginsSupported && (
            <SheetSection label={t("superpowersFilters.typeLabel")}>
              {typeFilters.map((option) => (
                <FilterRow
                  key={option.value}
                  icon={option.icon}
                  label={option.label}
                  active={filter === option.value}
                  onSelect={() => onFilterChange(option.value)}
                />
              ))}
            </SheetSection>
          )}

          <SheetSection label={t("superpowersFilters.sourceLabel")}>
            {originFilters.map((option) => (
              <FilterRow
                key={option.value}
                icon={option.icon}
                label={option.label}
                active={filter === option.value}
                onSelect={() => onFilterChange(option.value)}
              />
            ))}
          </SheetSection>

          {showCategories && (
            <SheetSection label={t("superpowersFilters.categoriesLabel")}>
              <FilterRow
                icon={LayoutGrid}
                label={t("superpowersFilters.filterLabel.all")}
                active={category === null}
                badge={showCounts ? totalCount : undefined}
                onSelect={() => onCategoryChange(null)}
              />
              {sortCategories(categories).map((cat) => (
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
            {t("superpowersFilters.done")}
          </Button>
        </BottomSheet.Footer>
      </BottomSheet.Content>
    </BottomSheet.Root>
  );
}

/** Section grouping inside the filter sheet. */
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
 * Status/Type/Source axes where the branded highlight alone is easy to miss.
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

/** Alphabetical by label, leaving the caller's array untouched. */
function sortCategories(categories: CategoryInfo[]): CategoryInfo[] {
  return [...categories].sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Categories as popover options, mirroring the sheet's Categories section.
 * Scrolls independently of the fixed Status/Type/Source groups above it, since
 * an assistant can carry many categories.
 */
function CategoryGroup({
  categories,
  category,
  counts,
  totalCount,
  showCounts,
  allLabel,
  categoriesLabel,
  onSelect,
}: {
  categories: CategoryInfo[];
  category: string | null;
  counts: Record<string, number>;
  totalCount: number;
  showCounts: boolean;
  allLabel: string;
  categoriesLabel: string;
  onSelect: (category: string | null) => void;
}) {
  const rows: { slug: string | null; label: string; count: number }[] = [
    { slug: null, label: allLabel, count: totalCount },
    ...sortCategories(categories).map((cat) => ({
      slug: cat.slug,
      label: cat.label,
      count: counts[cat.slug] ?? 0,
    })),
  ];

  return (
    <OptionGroup label={categoriesLabel}>
      <ul className="max-h-48 overflow-y-auto">
        {rows.map((row) => {
          const isSelected = category === row.slug;
          return (
            <li key={row.slug ?? "all"}>
              <button
                type="button"
                onClick={() => onSelect(row.slug)}
                role="option"
                aria-selected={isSelected}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-body-medium-lighter transition-colors hover:bg-[var(--surface-hover)]"
                style={{
                  color: isSelected
                    ? "var(--primary-base)"
                    : "var(--content-default)",
                }}
              >
                <span className="flex-1 truncate">{row.label}</span>
                {showCounts && (
                  <span style={{ color: "var(--content-tertiary)" }}>
                    {row.count}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </OptionGroup>
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
  selected: SuperpowerFilter;
  onSelect: (v: SuperpowerFilter) => void;
}) {
  return (
    <OptionGroup label={label}>
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
                {isSelected && (
                  <CheckCircle className="h-3.5 w-3.5" aria-hidden />
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </OptionGroup>
  );
}

/**
 * One labelled section of a popover listbox. `role="group"` plus the heading as
 * its accessible name ties the visible label to the options it heads, so a
 * screen reader announces which axis an option belongs to.
 */
function OptionGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <li role="group" aria-label={label}>
      <div
        className="px-3 pb-1 pt-2 text-body-small-default uppercase tracking-wide"
        style={{ color: "var(--content-tertiary)" }}
      >
        {label}
      </div>
      {children}
    </li>
  );
}
