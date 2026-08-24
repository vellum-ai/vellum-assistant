import { useQuery } from "@tanstack/react-query";

import { organizationsBillingSummaryRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { useSuppressCreditBannersForByok } from "@/hooks/use-byok-credit-banner-gate";
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
  /**
   * Server-computed daily-limit state: today's Vellum credit spend has reached
   * the org's configured daily cap. Independent of the balance, so it holds
   * even when credits remain. Drives the composer's daily-limit banner
   * proactively, without waiting for a send to fail.
   */
  dailyLimitReached: boolean;
  /**
   * Server-computed: the daily limit has been skipped for the current UTC day,
   * so it is configured but not being enforced. Mutually exclusive with
   * {@link BillingBalanceStatus.dailyLimitReached} by construction: the
   * platform derives `daily_limit_reached` as false while a skip is active.
   */
  dailyLimitSnoozed: boolean;
  /** The configured daily limit as a decimal string, or null when unset. */
  dailyLimit: string | null;
  /** Today's (UTC) credit spend as a decimal string, or null when unknown. */
  dailySpend: string | null;
  /** Effective balance as a decimal string, or null when unknown. */
  balance: string | null;
  /**
   * Unused credit still sitting on the unexpired usage grants (the initial
   * credit and a Pro sub's monthly bundle), as a decimal string. This is what
   * the Usage Balance bar measures, and what the credit figures net out.
   */
  availableUsageBalance: string | null;
  /**
   * What those same grants were originally worth, as a decimal string. The
   * denominator of a free plan's Usage Balance bar.
   */
  totalUsageBalance: string | null;
  /** Whether the billing summary query is allowed to run at all. */
  enabled: boolean;
}

const INERT_STATUS: Omit<BillingBalanceStatus, "enabled"> = {
  isExhausted: false,
  isLowBalance: false,
  dailyLimitReached: false,
  dailyLimitSnoozed: false,
  dailyLimit: null,
  dailySpend: null,
  balance: null,
  availableUsageBalance: null,
  totalUsageBalance: null,
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
 * or exhausted ({@link BillingBalanceStatus.isExhausted}), plus the orthogonal
 * daily-limit flag ({@link BillingBalanceStatus.dailyLimitReached}).
 *
 * Inert (all-false, null balance) for self-hosted assistants, missing platform
 * sessions, an unhydrated org store, and while the summary is loading: unknown
 * state must never flash a billing surface. Freshness rides the QueryClient
 * defaults (10s staleTime, refetch-on-focus) plus the turn-end invalidation in
 * `use-conversation-history`. Focus refetches reach Capacitor iOS and Electron
 * too, because `lib/query-focus-manager` feeds TanStack Query's focusManager
 * from the event bus's `app.resume` signal, so a user coming back to an
 * already-open app sees the daily-limit banner without a reload.
 *
 * The balance flags additionally stay down when the effective chat route is
 * provably BYOK and no managed credits were burned in the last day (see
 * {@link useSuppressCreditBannersForByok}): chat turns that dispatch on the
 * user's own key never fail on the managed wallet, so the credit wall would
 * be a false alarm. Chat surfaces pass their active `conversationId` so a
 * managed per-conversation profile pin keeps the banners up over a BYOK
 * global default; client-minted drafts (no server row) pass the
 * composer-stashed `draftProfile` instead. `dailyLimitReached` is exempt, since it can only be true
 * with managed spend today, which is exactly the burn that re-arms the
 * others.
 */
export function useBillingBalanceStatus(
  opts: { conversationId?: string | null; draftProfile?: string | null } = {},
): BillingBalanceStatus {
  const enabled = useBillingBalanceQueryEnabled();
  const { data: summary } = useQuery({
    ...organizationsBillingSummaryRetrieveOptions(),
    enabled,
  });
  const isExhausted = !!summary && Number(summary.effective_balance) <= 0;
  const isLowBalance = !!summary && summary.low_balance_warning === true;
  const suppressed = useSuppressCreditBannersForByok(
    enabled && (isExhausted || isLowBalance),
    opts.conversationId,
    opts.draftProfile,
  );
  if (!enabled || !summary) {
    return { ...INERT_STATUS, enabled };
  }
  return {
    isExhausted: isExhausted && !suppressed,
    isLowBalance: isLowBalance && !suppressed,
    dailyLimitReached: summary.daily_limit_reached === true,
    dailyLimitSnoozed: summary.daily_limit_snoozed === true,
    dailyLimit: summary.daily_credit_limit_usd ?? null,
    dailySpend: summary.daily_spend_usd ?? null,
    balance: summary.effective_balance,
    // A platform that predates the usage-grant fields reports neither, which
    // reads as no grant information rather than a zeroed one.
    availableUsageBalance: summary.available_usage_balance ?? null,
    totalUsageBalance: summary.total_usage_balance ?? null,
    enabled,
  };
}
