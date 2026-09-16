import { useTranslation } from "@/i18n";

const FIELD_CLASSES =
  "h-9 rounded-lg border border-[var(--border-element)] bg-[var(--field-bg)] px-3 text-[14px] text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] outline-none transition-[border-color] duration-150 focus:border-[var(--border-active)] disabled:cursor-not-allowed disabled:opacity-60";

export interface EmailAddressFieldsProps {
  prefix: string;
  /** Set at onboarding; drawn as the fixed domain after the `@`, not edited. */
  handle: string;
  rootDomain: string;
  onPrefixChange: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}

/**
 * `prefix @ handle.root`: the one field the address still needs once
 * onboarding has fixed the handle. The `@` and the domain beside the field
 * already say what it is, so the field carries its name for assistive
 * technology only. Input is lowercased and trimmed as typed, matching the
 * platform's username rules.
 */
export function EmailAddressFields({
  prefix,
  handle,
  rootDomain,
  onPrefixChange,
  disabled = false,
  autoFocus = false,
}: EmailAddressFieldsProps) {
  const { t } = useTranslation("assistant-inbox");

  return (
    <div className="flex items-center gap-2">
      <input
        aria-label={t("emailAddressFields.prefixLabel")}
        value={prefix}
        onChange={(event) =>
          onPrefixChange(event.target.value.toLowerCase().trim())
        }
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={t("emailAddressFields.prefixPlaceholder")}
        className={`${FIELD_CLASSES} w-24`}
      />
      <span className="text-[var(--content-secondary)]">@</span>
      <span className="min-w-0 truncate text-[14px] font-medium text-[var(--content-default)]">
        {handle}.{rootDomain}
      </span>
    </div>
  );
}
