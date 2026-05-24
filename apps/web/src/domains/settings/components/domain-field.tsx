import type { ReactNode } from "react";

interface DomainFieldProps {
  subdomain: string;
  onSubdomainChange: (value: string) => void;
  domainSuffix: string;
  subdomainPlaceholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  prefix?: ReactNode;
  error?: string | null;
  locked?: boolean;
  lockedMessage?: string;
}

export function DomainField({
  subdomain,
  onSubdomainChange,
  domainSuffix,
  subdomainPlaceholder = "my-assistant",
  disabled,
  autoFocus,
  prefix,
  error,
  locked,
  lockedMessage,
}: DomainFieldProps) {
  const borderClass = error
    ? "border-[var(--system-negative-strong)]"
    : "border-[var(--field-border)] focus-within:border-[var(--border-active)]";

  return (
    <div>
      <div className={`flex h-9 w-full items-center rounded-md border bg-[var(--field-bg)] text-body-medium-lighter transition-[border-color] duration-150 ${borderClass}`}>
        {prefix}
        <input
          value={subdomain}
          onChange={(e) => onSubdomainChange(e.target.value.toLowerCase().trim())}
          disabled={disabled || locked}
          readOnly={locked}
          autoFocus={autoFocus}
          placeholder={subdomainPlaceholder}
          aria-label="Subdomain"
          aria-invalid={!!error}
          className={`h-full min-w-0 flex-1 bg-transparent ${prefix ? "pl-1.5" : "pl-3"} pr-1 text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] outline-none disabled:cursor-not-allowed disabled:opacity-60`}
        />
        <span className="shrink-0 pr-3 font-mono text-[var(--content-secondary)]">
          .{domainSuffix}
        </span>
      </div>
      {error && (
        <p className="mt-1.5 text-body-small-default text-[var(--system-negative-strong)]">
          {error}
        </p>
      )}
      {locked && lockedMessage && (
        <p className="mt-1.5 text-body-small-default text-[var(--content-tertiary)]">
          {lockedMessage}
        </p>
      )}
    </div>
  );
}
