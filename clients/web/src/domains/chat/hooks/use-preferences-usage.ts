/**
 * The preferences menu's usage reading: the share of the usage credit the org
 * was granted that is already used, and whether the wallet behind it still has
 * anything to draw on.
 *
 * Read by the menu's usage panel and by the menu itself, which decides from
 * the same numbers whether its credits row belongs on screen. Composing it
 * once means the two can never disagree about the reading, and the queries
 * behind it dedupe through TanStack Query rather than firing twice.
 */

import { useQuery } from "@tanstack/react-query";

import { organizationsBillingSubscriptionRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { useBillingBalanceStatus } from "@/hooks/use-billing-balance-status";
import { awaitsAnswer } from "@/lib/query-awaits-answer";
import { useByokCreditRouteVerdict } from "@/hooks/use-byok-credit-banner-gate";
import { usePlanUsageBalance } from "@/hooks/use-plan-usage-balance";

export interface PreferencesUsage {
  /** Used share of the granted usage credit, clamped to 0..1. */
  ratio: number;
  /** The whole granted credit is used, which is the negative reading. */
  spent: boolean;
  /** The grants are used up and the wallet behind them is empty too. */
  exhausted: boolean;
  /**
   * The grants are used up, the wallet behind them provably holds credit,
   * and the active route actually burns managed credits, so the next turn
   * draws on extra usage credits. Reads the raw balance rather than
   * {@link exhausted} and asks the BYOK route classifier itself: a turn that
   * dispatches on the user's own key must not be described as spending extra
   * credits, whatever the wallet holds.
   */
  usingExtraCredits: boolean;
}

export interface PreferencesUsageReading {
  /** The reading, or null when there is nothing honest to say. */
  usage: PreferencesUsage | null;
  /**
   * The reading is final. While false, `usage` is still being worked out: a
   * null may yet become a bar, and a bar's `usingExtraCredits` may yet become
   * true. Colour carries meaning on this panel, so a caller that paints an
   * alarm colour waits for this rather than reading a not-yet as a no.
   */
  settled: boolean;
}

/**
 * A null `usage` while the org has no managed billing to read and before an
 * honest number lands, so every caller renders exactly what it always has
 * until there is something real to say, paired with the `settled` flag that
 * separates the two: a null that is still landing from one that is the answer.
 *
 * `conversationId` is the chat the reading is for. It reaches the wallet
 * status so a managed per-conversation profile pin classifies `exhausted`
 * against the route that chat actually dispatches on, rather than against the
 * global default.
 */
export function usePreferencesUsage(
  opts: { conversationId?: string | null } = {},
): PreferencesUsageReading {
  const {
    isExhausted,
    balance,
    availableUsageBalance,
    totalUsageBalance,
    enabled,
    settled: balanceSettled,
  } = useBillingBalanceStatus({ conversationId: opts.conversationId ?? null });
  // The sub is only worth fetching when the org actually has managed billing;
  // the reading itself comes off the summary the wallet status already read.
  const subscriptionQuery = useQuery({
    ...organizationsBillingSubscriptionRetrieveOptions(),
    enabled,
  });
  const usage = usePlanUsageBalance({
    subscription: subscriptionQuery.data,
    availableUsageBalance,
    totalUsageBalance,
  });

  const spent = usage != null && usage.ratio >= 1;
  // The raw balance rather than `isExhausted`, which stays down on a
  // provably-BYOK route: right for the credit wall, wrong for claiming the
  // next turn spends extra credits. A null balance is unknown, not credit,
  // so the claim also waits for a summary proving the wallet holds something.
  const hasWalletCredit = balance != null && Number(balance) > 0;
  // A wallet with credit is still not proof it gets spent: a BYOK route
  // dispatches the next turn on the user's own key. The classifier's queries
  // stay idle until the claim is otherwise live, so the common healthy path
  // costs nothing.
  const { settled: claimSettled, routeBurnsManaged } =
    useByokCreditRouteVerdict(
      enabled && spent && hasWalletCredit,
      opts.conversationId ?? null,
    );

  // The reading is final once the summary and the subscription behind it have
  // both answered and the route classification has stopped moving. The
  // subscription is the second half of `usage`: without it there is no plan to
  // read the grants against, so a null here is pending rather than none.
  const settled =
    balanceSettled && !awaitsAnswer(subscriptionQuery) && claimSettled;

  if (!enabled || !usage) {
    return { usage: null, settled };
  }
  return {
    usage: {
      ratio: usage.ratio,
      spent,
      // Using up the grants only alarms once the wallet behind them is empty
      // too, and only once that is settled: the strip and the bar's colour
      // then arrive on the same render instead of the strip growing the
      // popover a beat later.
      exhausted: settled && spent && isExhausted,
      // A managed route is the whole basis for the claim, so it is required
      // rather than inferred from `suppress` not being set. The gate lowers
      // suppression for a fail-open null and for a BYOK route with spend on
      // some other surface, and neither means this conversation's next turn
      // touches the managed wallet.
      usingExtraCredits:
        settled && routeBurnsManaged && spent && hasWalletCredit,
    },
    settled,
  };
}
