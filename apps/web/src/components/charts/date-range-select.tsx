import { useMemo } from "react";

import {
  Dropdown,
  type DropdownOption,
} from "@vellum/design-library/components/dropdown";

import { toLocalDateString } from "@/components/charts/format-date-label.js";

export interface DateRange {
  readonly from: string;
  readonly to: string;
}

interface DateRangeSelectProps {
  readonly value: DateRange;
  readonly onChange: (range: DateRange) => void;
}

type PresetDays = "7" | "30" | "90";

const PRESET_OPTIONS: ReadonlyArray<DropdownOption<PresetDays>> = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
];

function computeRange(days: number): DateRange {
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - (days - 1));
  return {
    from: toLocalDateString(from),
    to: toLocalDateString(today),
  };
}

function daysBetween(from: string, to: string): number {
  const msPerDay = 86_400_000;
  const fromDate = new Date(from);
  const toDate = new Date(to);
  return Math.round((toDate.getTime() - fromDate.getTime()) / msPerDay) + 1;
}

export function DateRangeSelect({ value, onChange }: DateRangeSelectProps) {
  const selectedPreset = useMemo<PresetDays>(() => {
    const days = daysBetween(value.from, value.to);
    if (days === 7) return "7";
    if (days === 90) return "90";
    return "30";
  }, [value.from, value.to]);

  const handleChange = (preset: PresetDays) => {
    onChange(computeRange(Number(preset)));
  };

  return (
    <Dropdown<PresetDays>
      options={PRESET_OPTIONS}
      value={selectedPreset}
      onChange={handleChange}
      aria-label="Date range"
    />
  );
}
