import { useTranslation } from "@/i18n";

const FIELD_CLASSES =
  "h-9 rounded-lg border border-[var(--border-element)] bg-[var(--field-bg)] px-3 text-[14px] text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] outline-none transition-[border-color] duration-150 focus:border-[var(--border-active)] disabled:cursor-not-allowed disabled:opacity-60";
const LABEL_CLASSES = "text-[11px] font-medium text-[var(--content-secondary)]";

export interface EmailAddressFieldsProps {
  prefix: string;
  handle: string;
  rootDomain: string;
  onPrefixChange: (value: string) => void;
  /**
   * Omit to lock the handle: it is drawn as the fixed domain after the `@`
   * rather than as a field, for the surfaces where onboarding has already
   * set it and only the prefix is still the user's to choose.
   */
  onHandleChange?: (value: string) => void;
  disabled?: boolean;
  /** Focus the first editable field on mount. */
  autoFocus?: boolean;
}

/**
 * `prefix @ handle .root`: the address builder the upgrade state and the
 * setup card share, so the two never disagree on what an address looks
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
  autoFocus = false,
}: EmailAddressFieldsProps) {
  const { t } = useTranslation("assistant-inbox");
  const handleLocked = !onHandleChange;

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
          autoFocus={autoFocus && handleLocked}
          placeholder={t("emailAddressFields.prefixPlaceholder")}
          className={`${FIELD_CLASSES} w-24`}
        />
      </div>
      <span className="flex h-9 items-center text-[var(--content-secondary)]">
        @
      </span>
      {handleLocked ? (
        <span className="flex h-9 min-w-0 items-center truncate text-[14px] font-medium text-[var(--content-default)]">
          {handle}.{rootDomain}
        </span>
      ) : (
        <>
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
              autoFocus={autoFocus}
              placeholder={t("emailAddressFields.handlePlaceholder")}
              className={`${FIELD_CLASSES} w-full min-w-0`}
            />
          </div>
          <span className="flex h-9 shrink-0 items-center text-[14px] text-[var(--content-tertiary)]">
            .{rootDomain}
          </span>
        </>
      )}
    </div>
  );
}
