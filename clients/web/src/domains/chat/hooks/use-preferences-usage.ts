/**
 * The preferences menu's usage reading behind the `obscure-credits` flag: the
 * share of the usage credit the org was granted that is already used, and
 * whether the wallet behind it still has anything to draw on.
 *
 * Read by the menu's usage panel and by the menu itself, which decides from
 * the same numbers whether its credits row belongs on screen. Composing it
 * once means the two can never disagree about the reading, and the queries
 * behind it dedupe through TanStack Query rather than firing twice.
 */

import { useQuery } from "@tanstack/react-query";

import { organizationsBillingSubscriptionRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { useBillingBalanceStatus } from "@/hooks/use-billing-balance-status";
import { usePlanUsageBalance } from "@/hooks/use-plan-usage-balance";
import { useObscureCredits } from "@/hooks/use-obscure-credits-flag";

export interface PreferencesUsage {
  /** Used share of the granted usage credit, clamped to 0..1. */
  ratio: number;
  /** The whole granted credit is used, which is the negative reading. */
  spent: boolean;
  /** The grants are used up and the wallet behind them is empty too. */
  exhausted: boolean;
}

/**
 * Null while the flag is off, while the org has no managed billing to read,
 * and before an honest number lands, so every caller renders exactly what it
 * always has until there is something real to say.
 *
 * `conversationId` is the chat the reading is for. It reaches the wallet
 * status so a managed per-conversation profile pin classifies `exhausted`
 * against the route that chat actually dispatches on, rather than against the
 * global default.
 */
export function usePreferencesUsage(
  opts: { conversationId?: string | null } = {},
): PreferencesUsage | null {
  const obscureCredits = useObscureCredits();
  const {
    isExhausted,
    availableUsageBalance,
    totalUsageBalance,
    enabled: billingEnabled,
  } = useBillingBalanceStatus({ conversationId: opts.conversationId ?? null });
  // The sub is only worth fetching when the flag is on and the org actually
  // has managed billing; the reading itself comes off the summary the wallet
  // status already read.
  const enabled = obscureCredits && billingEnabled;
  const subscriptionQuery = useQuery({
    ...organizationsBillingSubscriptionRetrieveOptions(),
    enabled,
  });
  const usage = usePlanUsageBalance({
    subscription: subscriptionQuery.data,
    availableUsageBalance,
    totalUsageBalance,
  });

  if (!enabled || !usage) {
    return null;
  }
  const spent = usage.ratio >= 1;
  return {
    ratio: usage.ratio,
    spent,
    // Using up the grants only alarms once the wallet behind them is empty
    // too.
    exhausted: spent && isExhausted,
  };
}
