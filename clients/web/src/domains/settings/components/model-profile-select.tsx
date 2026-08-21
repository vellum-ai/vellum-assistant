import { AlertCircle } from "lucide-react";

import { Select } from "@vellumai/design-library/components/select";

import { useProfileOptions } from "@/domains/settings/hooks/use-profile-options";
import { useTranslation } from "@/i18n";

import type {
  SelectMenuAlign,
  SelectVariant,
} from "@vellumai/design-library/components/select";

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
  /** Trigger chrome. `"ghost"` suits a run of otherwise read-only rows. */
  variant?: SelectVariant;
  /**
   * Which trigger edge the menu is anchored to. Pair `"end"` with a
   * right-aligned trigger, whose menu is usually wider than it is and would
   * otherwise grow rightwards into the surface edge.
   */
  menuAlign?: SelectMenuAlign;
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
  variant,
  menuAlign,
}: ModelProfileSelectProps) {
  const { t } = useTranslation("settings");
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
      value: option.value,
      label: option.label,
    }));

  return (
    <Select
      value={value}
      onChange={onChange}
      onSelectNone={() => onChange(null)}
      options={options}
      disabled={disabled || isSaving}
      placeholder={placeholder}
      className={className}
      variant={variant}
      menuAlign={menuAlign}
      aria-label={t("modelProfileSelect.ariaLabel")}
    />
  );
}
