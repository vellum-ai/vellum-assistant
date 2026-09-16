import { useTranslation } from "@/i18n";

const FIELD_CLASSES =
  "h-9 rounded-lg border border-[var(--border-element)] bg-[var(--field-bg)] px-3 text-[14px] text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] outline-none transition-[border-color] duration-150 focus:border-[var(--border-active)] disabled:cursor-not-allowed disabled:opacity-60";
const LABEL_CLASSES = "text-[11px] font-medium text-[var(--content-secondary)]";

export interface EmailAddressFieldsProps {
  prefix: string;
  handle: string;
  rootDomain: string;
  onPrefixChange: (value: string) => void;
  onHandleChange: (value: string) => void;
  disabled?: boolean;
  /** Focus the handle on mount, for the card where it is the one decision. */
  autoFocusHandle?: boolean;
}

/**
 * `prefix @ handle .root`: the address builder both the upgrade state and
 * the setup card share, so the two never disagree on what an address looks
 * like. Input is lowercased and trimmed as typed, matching the platform's
 * subdomain rules.
 */
export function EmailAddressFields({
  prefix,
  handle,
  rootDomain,
  onPrefixChange,
  onHandleChange,
  disabled = false,
  autoFocusHandle = false,
}: EmailAddressFieldsProps) {
  const { t } = useTranslation("assistant-inbox");

  return (
    <div className="flex items-end gap-2">
      <div className="flex flex-col gap-1">
        <label htmlFor="assistant-inbox-prefix" className={LABEL_CLASSES}>
          {t("emailAddressFields.prefixLabel")}
        </label>
        <input
          id="assistant-inbox-prefix"
          value={prefix}
          onChange={(event) =>
            onPrefixChange(event.target.value.toLowerCase().trim())
          }
          disabled={disabled}
          placeholder={t("emailAddressFields.prefixPlaceholder")}
          className={`${FIELD_CLASSES} w-24`}
        />
      </div>
      <span className="flex h-9 items-center text-[var(--content-secondary)]">
        @
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <label htmlFor="assistant-inbox-handle" className={LABEL_CLASSES}>
          {t("emailAddressFields.handleLabel")}
        </label>
        <input
          id="assistant-inbox-handle"
          value={handle}
          onChange={(event) =>
            onHandleChange(event.target.value.toLowerCase().trim())
          }
          disabled={disabled}
          autoFocus={autoFocusHandle}
          placeholder={t("emailAddressFields.handlePlaceholder")}
          className={`${FIELD_CLASSES} w-full min-w-0`}
        />
      </div>
      <span className="flex h-9 shrink-0 items-center text-[14px] text-[var(--content-tertiary)]">
        .{rootDomain}
      </span>
    </div>
  );
}
