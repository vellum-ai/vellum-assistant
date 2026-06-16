import { Dropdown } from "@vellumai/design-library/components/dropdown";

import { useProfileOptions } from "@/domains/settings/hooks/use-profile-options";

/**
 * Sentinel value standing in for the `null` "Default" option, since
 * `Dropdown` keys options by non-empty string and uses `""` for "no
 * selection". The leading Default option carries `value: null`, so it maps
 * to this sentinel on the way in and back to `null` on the way out.
 */
const DEFAULT_OPTION_VALUE = "__default__";

export interface ModelProfileSelectProps {
  assistantId: string;
  /** Selected profile key, or `null` for the "Default" (cleared override) option. */
  value: string | null;
  onChange: (profileKey: string | null) => void;
  disabled?: boolean;
  isSaving?: boolean;
}

/**
 * Controlled inference-profile picker built from {@link useProfileOptions}.
 * Reports the selected profile key — or `null` for the leading "Default"
 * option that clears an override — through `onChange`.
 */
export function ModelProfileSelect({
  assistantId,
  value,
  onChange,
  disabled = false,
  isSaving = false,
}: ModelProfileSelectProps) {
  const options = useProfileOptions(assistantId).map((option) => ({
    value: option.value ?? DEFAULT_OPTION_VALUE,
    label: option.label,
  }));

  return (
    <Dropdown
      value={value ?? DEFAULT_OPTION_VALUE}
      onChange={(selected) =>
        onChange(selected === DEFAULT_OPTION_VALUE ? null : selected)
      }
      options={options}
      disabled={disabled || isSaving}
    />
  );
}
