import { Dropdown } from "@vellumai/design-library/components/dropdown";

import { useProfileOptions } from "@/domains/settings/hooks/use-profile-options";

const DEFAULT_PROFILE_OPTION_VALUE = "__default_profile__";

export function profileOptionToDropdownValue(value: string | null): string {
  return value ?? DEFAULT_PROFILE_OPTION_VALUE;
}

export function dropdownValueToProfileOption(value: string): string | null {
  return value === DEFAULT_PROFILE_OPTION_VALUE ? null : value;
}

export interface ModelProfileSelectProps {
  assistantId: string;
  value: string | null;
  onChange: (profileKey: string | null) => void;
  disabled?: boolean;
  isSaving?: boolean;
  className?: string;
}

export function ModelProfileSelect({
  assistantId,
  value,
  onChange,
  disabled = false,
  isSaving = false,
  className,
}: ModelProfileSelectProps) {
  const options = useProfileOptions(assistantId, value).map((option) => ({
    value: profileOptionToDropdownValue(option.value),
    label: option.label,
  }));

  return (
    <Dropdown
      value={profileOptionToDropdownValue(value)}
      onChange={(selected) => onChange(dropdownValueToProfileOption(selected))}
      options={options}
      disabled={disabled || isSaving}
      className={className}
      aria-label="Model profile"
    />
  );
}
