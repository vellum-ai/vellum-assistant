import type { FeedItemGuardianRequest } from "@vellumai/assistant-api";
import {
  type GuardianActionEmphasis,
  type GuardianDecisionActionId,
  GuardianDecisionActionIdSchema,
} from "@vellumai/service-contracts/guardian-requests";

/** One decision a pending approval offers, as the bell renders it. */
export interface GuardianDecisionOption {
  id: GuardianDecisionActionId;
  emphasis?: GuardianActionEmphasis;
}

/**
 * The pair offered for a request whose projection names no decisions: the
 * generic approval every approval-mode request kind accepts.
 */
const GENERIC_DECISION_OPTIONS: readonly GuardianDecisionOption[] = [
  { id: "approve_once", emphasis: "primary" },
  { id: "reject", emphasis: "destructive" },
];

/**
 * The decisions a pending approval offers, in the order its card offers
 * them. The daemon projects them onto the feed item (`decisionActions`) from
 * the same source the request's cards are built from, so an access request
 * offers Trust / Verify with a code / Leave unverified / Block rather than a
 * generic Approve that would resolve to something the guardian did not see.
 * An id this client does not know is skipped.
 */
export function resolveGuardianDecisionOptions(
  guardianRequest: Pick<FeedItemGuardianRequest, "decisionActions">,
): readonly GuardianDecisionOption[] {
  const { decisionActions } = guardianRequest;
  if (!decisionActions) {
    return GENERIC_DECISION_OPTIONS;
  }
  return decisionActions.flatMap((action) => {
    const id = GuardianDecisionActionIdSchema.safeParse(action.id);
    if (!id.success) {
      return [];
    }
    return [
      {
        id: id.data,
        ...(action.emphasis ? { emphasis: action.emphasis } : {}),
      },
    ];
  });
}
