import { useMemo, useState } from "react";

/** What a per-tenant provider asks the user for before a connect can start. */
export interface TenantHostRequirement {
  /** Validation pattern, mirrored from the platform's provider registry. */
  pattern: string;
  label: string;
  placeholder: string;
}

export interface TenantHostInput {
  value: string;
  setValue: (value: string) => void;
  /** The host to send, or `undefined` when the provider has no use for one. */
  normalized: string | undefined;
  /** True when a connect may start: no host is needed, or the typed one fits. */
  valid: boolean;
  /** Show the error once there is something to judge, never on an empty field. */
  showsInvalid: boolean;
}

/**
 * Local state for the host a per-tenant provider needs before a managed
 * connect can start. Shopify's OAuth endpoints live on the merchant's own
 * `*.myshopify.com`, so there is nothing to open until the user says which.
 *
 * Validation uses the pattern the platform applies server-side, so a typo is
 * caught here rather than by an authorization window opening onto an error.
 * With no `requirement` the input is inert: `valid` is true and `normalized`
 * is `undefined`, so callers pass the result straight through for every
 * provider.
 */
export function useTenantHostInput(
  requirement: TenantHostRequirement | null | undefined,
): TenantHostInput {
  const [value, setValue] = useState("");
  const pattern = requirement?.pattern;
  const matcher = useMemo(
    () => (pattern ? new RegExp(pattern) : null),
    [pattern],
  );
  const trimmed = value.trim().toLowerCase();
  const valid = !matcher || matcher.test(trimmed);
  return {
    value,
    setValue,
    normalized: requirement ? trimmed : undefined,
    valid,
    showsInvalid: Boolean(matcher) && trimmed.length > 0 && !valid,
  };
}
