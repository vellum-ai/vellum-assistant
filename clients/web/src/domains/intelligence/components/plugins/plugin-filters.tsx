import {
    ArrowDownToLine,
    Check,
    CheckCircle,
    Filter,
    LayoutGrid,
    Loader2,
    Search,
} from "lucide-react";
import { type ChangeEvent, type ReactNode, useState } from "react";

import type { PluginFilter } from "@/domains/intelligence/plugins/types";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { BottomSheet, Button, Input, PanelItem, Popover } from "@vellumai/design-library";

interface FilterOption {
  value: PluginFilter;
  label: string;
  icon: typeof LayoutGrid;
}

const STATUS_FILTERS: FilterOption[] = [
  { value: "all", label: "All", icon: LayoutGrid },
  { value: "installed", label: "Installed", icon: CheckCircle },
  { value: "available", label: "Available", icon: ArrowDownToLine },
];

interface FilterBarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  filter: PluginFilter;
  onFilterChange: (f: PluginFilter) => void;
  isSearching?: boolean;
}

export function FilterBar({
  searchValue,
  onSearchChange,
  filter,
  onFilterChange,
  isSearching = false,
}: FilterBarProps) {
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    onSearchChange(e.target.value);
  };

  return (
    <div className="flex items-center gap-3">
      <Input
        type="search"
        value={searchValue}
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

      <FilterControl filter={filter} onFilterChange={onFilterChange} />
    </div>
  );
}

interface FilterControlProps {
  filter: PluginFilter;
  onFilterChange: (v: PluginFilter) => void;
}

/**
 * Filter affordance for the Plugins page. The outlined button opens a compact
 * Status popover on desktop and a bottom sheet on mobile. Plugins expose no
 * category/source axes (unlike Skills), so Status is the sole filter group.
 */
function FilterControl({ filter, onFilterChange }: FilterControlProps) {
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
      <FilterSheet
        filter={filter}
        onFilterChange={onFilterChange}
        open={open}
        onOpenChange={setOpen}
        trigger={trigger}
      />
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
            selected={filter}
            onSelect={(v) => {
              onFilterChange(v);
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

function FilterSheet({
  filter,
  onFilterChange,
  open,
  onOpenChange,
  trigger,
}: FilterSheetProps) {
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

function FilterRow({
  icon,
  label,
  active,
  onSelect,
}: {
  icon: typeof LayoutGrid;
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <PanelItem
      icon={icon}
      label={label}
      active={active}
      activeVariant="branded"
      trailingAction={
        active ? (
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
