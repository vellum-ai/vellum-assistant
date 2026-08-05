import { useQuery } from "@tanstack/react-query";

import { organizationsBillingSummaryRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import {
  useActiveAssistantIsPlatformHosted,
  usePlatformGate,
} from "@/hooks/use-platform-gate";

export interface BillingBalanceStatus {
  /** Effective balance is at or below zero: the org is out of credits. */
  isExhausted: boolean;
  /**
   * Server-computed low-balance warning: balance above zero but below the
   * org's alert threshold, with auto-top-up off. The threshold lives on the
   * platform; it is never re-derived client-side.
   */
  isLowBalance: boolean;
  /** Effective balance as a decimal string, or null when unknown. */
  balance: string | null;
  /** Whether the billing summary query is allowed to run at all. */
  enabled: boolean;
}

const INERT_STATUS: Omit<BillingBalanceStatus, "enabled"> = {
  isExhausted: false,
  isLowBalance: false,
  balance: null,
};

/**
 * Whether the org-scoped billing summary query may fire: the active assistant
 * must be positively resolved as platform-hosted with a live platform session,
 * and the org store must be ready to supply the `Vellum-Organization-Id`
 * header. Shared by {@link useBillingBalanceStatus} and the turn-end billing
 * invalidation in `use-conversation-history` so the two gates never drift.
 */
export function useBillingBalanceQueryEnabled(): boolean {
  const billingPlatformGate = usePlatformGate({ platformHostedOnly: true });
  const isPlatformHosted = useActiveAssistantIsPlatformHosted();
  const isOrgReady = useIsOrgReady();
  return billingPlatformGate === "full" && isPlatformHosted && isOrgReady;
}

/**
 * Tri-state credit-balance status for the org's managed billing:
 * normal (both flags false), low ({@link BillingBalanceStatus.isLowBalance}),
 * or exhausted ({@link BillingBalanceStatus.isExhausted}).
 *
 * Inert (all-false, null balance) for self-hosted assistants, missing platform
 * sessions, an unhydrated org store, and while the summary is loading: unknown
 * state must never flash a billing surface. Freshness rides the QueryClient
 * defaults (10s staleTime, refetch-on-focus) plus the turn-end invalidation in
 * `use-conversation-history`.
 */
export function useBillingBalanceStatus(): BillingBalanceStatus {
  const enabled = useBillingBalanceQueryEnabled();
  const { data: summary } = useQuery({
    ...organizationsBillingSummaryRetrieveOptions(),
    enabled,
  });
  if (!enabled || !summary) {
    return { ...INERT_STATUS, enabled };
  }
  return {
    isExhausted: Number(summary.effective_balance) <= 0,
    isLowBalance: summary.low_balance_warning === true,
    balance: summary.effective_balance,
    enabled,
  };
}
