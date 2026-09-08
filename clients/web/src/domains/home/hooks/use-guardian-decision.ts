import { useCallback, useState } from "react";

import { useGuardianactionsDecisionPostMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { t } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { ApiError } from "@/utils/api-errors";
import { toast } from "@vellumai/design-library/components/toast";

import { useInvalidateHomeFeed } from "./use-home-feed-query";

/** The decisions a guardian can submit on a pending approval. */
export type GuardianDecisionAction = "approve_once" | "reject";

/**
 * How the last decision settled: what was decided on which request, whether
 * the daemon applied it, and if not, the reason it gave.
 */
export interface GuardianDecisionOutcome {
  requestId: string;
  action: GuardianDecisionAction;
  applied: boolean;
  reason?: string;
}

/**
 * Reasons that mean the request is no longer anyone's to decide: settled on
 * another surface, gone, or timed out. A surface holding such a request
 * shows it as retired. Every other reason (this actor may not decide it, the
 * record is unusable, the resolver failed) leaves the request as it was.
 */
const RETIRED_REASONS = new Set(["already_resolved", "not_found", "expired"]);

export function isRetiredDecisionReason(reason: string | undefined): boolean {
  return reason !== undefined && RETIRED_REASONS.has(reason);
}

/**
 * Say what happened to a decision the daemon declined, in the reason's own
 * terms. A retired request is news rather than a failure; a request this
 * actor may not decide, or that could not be applied, is a failure the user
 * has to hear so as not to retry a click that cannot succeed.
 */
function toastDeclinedDecision(reason: string | undefined): void {
  switch (reason) {
    case "already_resolved":
    case "not_found":
      toast.info(t("home:homeGuardianRequestCard.receipt.alreadyResolved"));
      return;
    case "expired":
      toast.info(t("home:homeGuardianRequestCard.receipt.expired"));
      return;
    case "identity_mismatch":
      toast.error(t("home:notificationsBell.decisionNotPermitted"));
      return;
    default:
      toast.error(t("home:notificationsBell.decisionNotApplied"));
  }
}

/**
 * The one way a surface decides a guardian request: the canonical decision
 * route, with every outcome handled the same wherever the click came from.
 *
 * The feed is refreshed after every response, since the row and the card
 * both draw their buttons off the feed item and the refresh is what retires
 * them once the request is settled. A 200 that declined the decision carries
 * a reason, which is reported as `outcome` and explained by a toast; a 404
 * means the request is gone and is folded into the same shape as the
 * `not_found` reason. Any other failure is captured and reported as a
 * submission failure, with nothing recorded as an outcome.
 */
export function useGuardianDecision(): {
  /** Submit a decision. Ignored until the active assistant has resolved. */
  decide: (requestId: string, action: GuardianDecisionAction) => void;
  /** True while a decision is in flight. */
  isPending: boolean;
  /** Whether a decision can be submitted at all. */
  canDecide: boolean;
  /** The last settled decision, or null before one settles. */
  outcome: GuardianDecisionOutcome | null;
} {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const invalidateFeed = useInvalidateHomeFeed(assistantId);
  const [outcome, setOutcome] = useState<GuardianDecisionOutcome | null>(null);

  const decision = useGuardianactionsDecisionPostMutation({
    onSuccess: (data, variables) => {
      const settled: GuardianDecisionOutcome = {
        requestId: variables.body.requestId,
        // The wire type is an open string; `decide` below only ever sends
        // one of the two actions.
        action: variables.body.action as GuardianDecisionAction,
        applied: data.applied,
        reason: data.reason,
      };
      setOutcome(settled);
      if (!settled.applied) {
        toastDeclinedDecision(settled.reason);
      }
      invalidateFeed();
    },
    onError: (error, variables) => {
      if (error instanceof ApiError && error.status === 404) {
        setOutcome({
          requestId: variables.body.requestId,
          action: variables.body.action as GuardianDecisionAction,
          applied: false,
          reason: "not_found",
        });
        toastDeclinedDecision("not_found");
        invalidateFeed();
        return;
      }
      captureError(error, { context: "guardian-decision" });
      toast.error(t("home:homeGuardianRequestCard.decisionFailed"));
    },
  });

  const { mutate } = decision;
  const decide = useCallback(
    (requestId: string, action: GuardianDecisionAction) => {
      if (!assistantId) {
        return;
      }
      mutate({
        path: { assistant_id: assistantId },
        body: { requestId, action },
      });
    },
    [assistantId, mutate],
  );

  return {
    decide,
    isPending: decision.isPending,
    canDecide: assistantId !== null,
    outcome,
  };
}
