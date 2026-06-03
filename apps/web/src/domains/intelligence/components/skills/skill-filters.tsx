import {
  ArrowDownToLine,
  Box,
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
  type SetStateAction,
  useState,
} from "react";

import { Button, Input, Popover } from "@vellum/design-library";
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
  { value: "vellum", label: "Vellum", icon: Box },
  { value: "clawhub", label: "Clawhub", icon: Globe },
  { value: "skillssh", label: "skills.sh", icon: Terminal },
  { value: "custom", label: "Custom", icon: User },
];

interface FilterBarProps {
  search: string;
  onSearchChange: Dispatch<SetStateAction<string>>;
  filter: SkillFilter;
  onFilterChange: (f: SkillFilter) => void;
  isSearching: boolean;
}

export function FilterBar({
  search,
  onSearchChange,
  filter,
  onFilterChange,
  isSearching,
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

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="outlined"
          iconOnly={<Filter aria-hidden />}
          aria-label="Filter skills"
          aria-haspopup="listbox"
          aria-expanded={open}
          tintColor="var(--primary-base)"
        />
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
