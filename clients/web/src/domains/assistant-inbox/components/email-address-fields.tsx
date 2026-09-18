import { useTranslation } from "@/i18n";

const FIELD_CLASSES =
  "h-9 rounded-lg border border-[var(--border-element)] bg-[var(--field-bg)] px-3 text-[14px] text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] outline-none transition-[border-color] duration-150 focus:border-[var(--border-active)] disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-[var(--system-negative-strong)]";

/** A DNS label: what a subdomain, and so a handle claimed here, may hold. */
function toHandleInput(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

export interface EmailAddressFieldsProps {
  prefix: string;
  handle: string;
  rootDomain: string;
  onPrefixChange: (value: string) => void;
  /**
   * Present when the handle is still the user's to choose, which draws it as
   * a second field. Omitted once a domain exists: the handle is then fixed,
   * and it reads as plain text after the `@`.
   */
  onHandleChange?: (value: string) => void;
  /** Marks the handle field invalid, for a handle that cannot be claimed. */
  handleInvalid?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
}

/**
 * `prefix @ handle.root`: the address, with whichever parts are still open
 * as fields. The `@` and the domain beside the fields already say what they
 * are, so they carry their names for assistive technology only. Input is
 * lowercased as typed, and the handle is held to what a subdomain allows,
 * matching the platform's rules.
 */
export function EmailAddressFields({
  prefix,
  handle,
  rootDomain,
  onPrefixChange,
  onHandleChange,
  handleInvalid = false,
  disabled = false,
  autoFocus = false,
}: EmailAddressFieldsProps) {
  const { t } = useTranslation("assistant-inbox");

  return (
    <div className="flex max-w-full items-center gap-2">
      <input
        aria-label={t("emailAddressFields.prefixLabel")}
        value={prefix}
        onChange={(event) =>
          onPrefixChange(event.target.value.toLowerCase().trim())
        }
        disabled={disabled}
        autoFocus={autoFocus && !onHandleChange}
        placeholder={t("emailAddressFields.prefixPlaceholder")}
        className={`${FIELD_CLASSES} w-24`}
      />
      <span className="text-[var(--content-secondary)]">@</span>
      {onHandleChange ? (
        <>
          <input
            aria-label={t("emailAddressFields.handleLabel")}
            aria-invalid={handleInvalid}
            value={handle}
            onChange={(event) =>
              onHandleChange(toHandleInput(event.target.value))
            }
            disabled={disabled}
            autoFocus={autoFocus}
            placeholder={t("emailAddressFields.handlePlaceholder")}
            className={`${FIELD_CLASSES} w-44 min-w-0`}
          />
          <span className="shrink-0 text-[14px] text-[var(--content-tertiary)]">
            .{rootDomain}
          </span>
        </>
      ) : (
        <span className="min-w-0 truncate text-[14px] font-medium text-[var(--content-default)]">
          {handle}.{rootDomain}
        </span>
      )}
    </div>
  );
}
