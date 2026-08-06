import { AlertCircle } from "lucide-react";

import { Select } from "@vellumai/design-library/components/select";

import { useProfileOptions } from "@/domains/settings/hooks/use-profile-options";

const DEFAULT_PROFILE_OPTION_VALUE = "__default_profile__";

export function profileOptionToSelectValue(value: string | null): string {
  return value ?? DEFAULT_PROFILE_OPTION_VALUE;
}

export function selectValueToProfileOption(value: string): string | null {
  return value === DEFAULT_PROFILE_OPTION_VALUE ? null : value;
}

export interface ModelProfileSelectProps {
  assistantId: string;
  value: string | null;
  onChange: (profileKey: string | null) => void;
  disabled?: boolean;
  isSaving?: boolean;
  className?: string;
  /**
   * Whether to offer the "Default" (null) option.
   *
   * Set false wherever null is not a state the subject can rest in. A schedule
   * is the case that matters: it always carries a concrete profile, and writing
   * null re-snapshots the current default rather than unpinning, so offering
   * "Default" there would promise a schedule can float with the user's default
   * when it cannot.
   */
  includeDefaultOption?: boolean;
  /**
   * Trigger text when `value` matches no offered option, which happens when a
   * pin names a profile that has since been deleted.
   */
  placeholder?: string;
}

export function ModelProfileSelect({
  assistantId,
  value,
  onChange,
  disabled = false,
  isSaving = false,
  className,
  includeDefaultOption = true,
  placeholder,
}: ModelProfileSelectProps) {
  const options = useProfileOptions(assistantId, value)
    .filter((option) => includeDefaultOption || option.value != null)
    .map((option) => ({
      ...(option.issue === "undispatchable"
        ? {
            icon: (
              <AlertCircle className="h-3.5 w-3.5 text-[var(--system-mid-strong)]" />
            ),
            ...(option.reason ? { tooltip: option.reason } : {}),
          }
        : {}),
      value: profileOptionToSelectValue(option.value),
      label: option.label,
    }));

  return (
    <Select
      value={profileOptionToSelectValue(value)}
      onChange={(selected) => onChange(selectValueToProfileOption(selected))}
      options={options}
      disabled={disabled || isSaving}
      placeholder={placeholder}
      className={className}
      aria-label="Model profile"
    />
  );
}
