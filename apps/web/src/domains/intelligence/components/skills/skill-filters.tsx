import {
  ArrowDownToLine,
  CheckCircle,
  ChevronDown,
  Globe,
  LayoutGrid,
  Loader2,
  Package,
  Search,
  Terminal,
  User,
} from "lucide-react";
import {
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
  useState,
} from "react";

import { Input, Popover } from "@vellum/design-library";
import {
  MobileSidebarTrigger,
} from "@/components/mobile-sidebar-drawer";
import type { SkillFilter } from "@/domains/intelligence/skills/types";

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
  { value: "vellum", label: "Vellum", icon: Package },
  { value: "clawhub", label: "Clawhub", icon: Globe },
  { value: "skillssh", label: "skills.sh", icon: Terminal },
  { value: "custom", label: "Custom", icon: User },
];

const FILTERS: FilterOption[] = [...STATUS_FILTERS, ...ORIGIN_FILTERS];

interface FilterBarProps {
  search: string;
  onSearchChange: Dispatch<SetStateAction<string>>;
  filter: SkillFilter;
  onFilterChange: (f: SkillFilter) => void;
  isSearching: boolean;
  onOpenDrawer: () => void;
}

export function FilterBar({
  search,
  onSearchChange,
  filter,
  onFilterChange,
  isSearching,
  onOpenDrawer,
}: FilterBarProps) {
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    onSearchChange(e.target.value);
  };

  return (
    <div className="flex items-center gap-3">
      <MobileSidebarTrigger onClick={onOpenDrawer} />
      <Input
        type="search"
        value={search}
        onChange={handleChange}
        placeholder="Search Skills"
        aria-label="Search Skills"
        leftIcon={<Search className="h-4 w-4" aria-hidden />}
        rightIcon={
          isSearching ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : undefined
        }
        fullWidth
        wrapperClassName="flex-1"
      />

      <FilterDropdown value={filter} onChange={onFilterChange} />
    </div>
  );
}

function FilterDropdown({
  value,
  onChange,
}: {
  value: SkillFilter;
  onChange: (v: SkillFilter) => void;
}) {
  const [open, setOpen] = useState(false);

  const current = FILTERS.find((f) => f.value === value) ?? ALL_FILTER;
  const CurrentIcon = current.icon;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          className="inline-flex w-40 items-center justify-between gap-2 rounded-lg border bg-[var(--surface-active)] px-3 py-2 text-body-medium-lighter transition-colors hover:bg-[var(--surface-hover)]"
          style={{
            borderColor: "var(--border-base)",
            color: "var(--content-default)",
          }}
        >
          <span className="flex items-center gap-2 truncate">
            <CurrentIcon className="h-4 w-4" aria-hidden />
            <span className="truncate">{current.label}</span>
          </span>
          <ChevronDown
            className="h-4 w-4"
            style={{ color: "var(--content-tertiary)" }}
            aria-hidden
          />
        </button>
      </Popover.Trigger>
      <Popover.Content
        align="end"
        sideOffset={4}
        className="w-44 overflow-hidden p-0"
      >
        <ul role="listbox">
          <FilterGroup
            label="Status"
            options={STATUS_FILTERS}
            selected={value}
            onSelect={(v) => {
              onChange(v);
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
            selected={value}
            onSelect={(v) => {
              onChange(v);
              setOpen(false);
            }}
          />
        </ul>
      </Popover.Content>
    </Popover.Root>
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
