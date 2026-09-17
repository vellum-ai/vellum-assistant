import { useMemo } from "react";

import type { TenantHostRequirement } from "@/hooks/use-tenant-host-input";
import { useTranslation } from "@/i18n";

/** The `tenant_host` field of a provider summary, as the assistant sends it. */
export type TenantHostWire = {
  pattern: string;
  label: string;
  placeholder: string;
} | null;

/**
 * Requirements for assistants that predate the `tenant_host` wire field.
 *
 * A summary from a current assistant always carries the key, as `null` or an
 * object, so an absent key (`undefined`) is an exact "older assistant" signal
 * rather than a guess. That is why this fallback keys on the field and not on
 * the version registry: there is no route that could answer 200 with the
 * wrong shape, and no release number to predict. Delete an entry once no
 * supported assistant predates the field.
 */
const LEGACY_REQUIREMENTS: Record<string, NonNullable<TenantHostWire>> = {
  shopify: {
    pattern: "^[a-z0-9][a-z0-9-]*\\.myshopify\\.com$",
    label: "Shop domain",
    placeholder: "your-store.myshopify.com",
  },
};

/**
 * The raw requirement for a provider, before any copy is applied: the wire
 * field when the assistant sends one, the legacy fallback when it does not.
 */
function tenantHostSource(
  providerKey: string,
  wire: TenantHostWire | undefined,
): NonNullable<TenantHostWire> | null {
  return wire === undefined ? (LEGACY_REQUIREMENTS[providerKey] ?? null) : wire;
}

/**
 * Does connecting this provider need a host from the user first? A surface
 * with nowhere to ask (an icon-sized action on a tile) sends them somewhere
 * that can instead of starting an authorization that cannot succeed.
 */
export function requiresTenantHost(
  providerKey: string,
  wire: TenantHostWire | undefined,
): boolean {
  return tenantHostSource(providerKey, wire) !== null;
}

/**
 * Resolve what to ask the user for before a per-tenant provider's managed
 * connect can start. `null` for providers with one global host.
 *
 * The validation pattern is the assistant's. The label and placeholder come
 * from the locale catalog when it has copy for the provider, since they are
 * user-facing; the assistant's English strings are the fallback for a
 * provider the catalog has not learned yet.
 */
export function useTenantHostRequirement(
  providerKey: string,
  wire: TenantHostWire | undefined,
): TenantHostRequirement | null {
  const { t } = useTranslation("common");
  return useMemo(() => {
    const source = tenantHostSource(providerKey, wire);
    if (!source) {
      return null;
    }
    const copy =
      providerKey === "shopify"
        ? {
            label: t("tenantHost.shopifyLabel"),
            placeholder: t("tenantHost.shopifyPlaceholder"),
          }
        : null;
    return {
      pattern: source.pattern,
      label: copy?.label ?? source.label,
      placeholder: copy?.placeholder ?? source.placeholder,
    };
  }, [providerKey, t, wire]);
}
