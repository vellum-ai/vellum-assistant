import { useCallback, useMemo } from "react";

import { useGuardianactionsDecisionPostMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { t } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { ApiError } from "@/utils/api-errors";
import { toast } from "@vellumai/design-library/components/toast";

import {
  type GuardianDecisionAction,
  type GuardianDecisionOutcome,
  useGuardianDecisionStore,
} from "../guardian-decision-store";
import { useInvalidateHomeFeed } from "./use-home-feed-query";

export type {
  GuardianDecisionAction,
  GuardianDecisionOutcome,
} from "../guardian-decision-store";

/**
 * Reasons that mean the request is no longer anyone's to decide: settled on
 * another surface, gone, or timed out. A surface holding such a request
 * shows it as retired.
 */
const RETIRED_REASONS = new Set(["already_resolved", "not_found", "expired"]);

/**
 * The daemon committed the decision but the step after it (the resolver
 * that acts on the decision) failed. The request is decided, and another
 * attempt can only come back `already_resolved`, so it is terminal here even
 * though it was reported as not applied. The daemon reports a persist that
 * never landed under its own reason (`decision_not_persisted`), which is
 * retryable and so is not in any set here.
 */
const RESOLVER_FAILED_REASON = "resolver_failed";

export function isRetiredDecisionReason(reason: string | undefined): boolean {
  return reason !== undefined && RETIRED_REASONS.has(reason);
}

/** Whether the daemon recorded the decision, whatever happened after. */
export function isCommittedDecision(outcome: GuardianDecisionOutcome): boolean {
  return outcome.applied || outcome.reason === RESOLVER_FAILED_REASON;
}

/**
 * Whether the request is settled as far as this client is concerned: the
 * decision was recorded, or the request turned out to be nobody's to decide.
 * Every other reason (this actor may not decide it, the record is unusable,
 * the persist never landed) leaves the request pending and its buttons in
 * place.
 */
export function isTerminalDecision(outcome: GuardianDecisionOutcome): boolean {
  return (
    isCommittedDecision(outcome) || isRetiredDecisionReason(outcome.reason)
  );
}

/**
 * Say what happened to a decision the daemon declined, in the reason's own
 * terms. A retired request is news rather than a failure; a decision that
 * was recorded but not followed through, one this actor may not make, or
 * one that could not be applied is a failure the user has to hear so as not
 * to retry a click that cannot succeed, or so as to retry one that can.
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
    case RESOLVER_FAILED_REASON:
      toast.error(t("home:notificationsBell.decisionFollowThroughFailed"));
      return;
    case "identity_mismatch":
      toast.error(t("home:notificationsBell.decisionNotPermitted"));
      return;
    default:
      // `request_misconfigured`, `decision_not_persisted`, and anything a
      // newer daemon adds: the decision did not take, and the row stays.
      toast.error(t("home:notificationsBell.decisionNotApplied"));
  }
}

/**
 * The one way a surface decides a guardian request: the canonical decision
 * route, with every outcome handled the same wherever the click came from.
 *
 * The feed is refreshed after every response, since the row and the card
 * both draw their buttons off the feed item and the refresh is what retires
 * them once the daemon projects the settled request. That projection can lag
 * the response (an expiry is only written by a periodic sweep, a resolver
 * failure is written asynchronously), so every outcome is also recorded in
 * the shared decision store, and a surface consults `decidedRequestIds` to
 * keep a settled request's buttons down until the feed catches up. Shared
 * rather than local so a request decided from the bell's row reads as
 * decided in its detail, and the other way round.
 *
 * A 200 that declined the decision carries a reason, which is recorded as
 * the outcome and explained by a toast; a 404 means the request is gone and
 * is folded into the same shape as the `not_found` reason. Any other failure
 * is captured and reported as a submission failure, with nothing recorded.
 */
export function useGuardianDecision(): {
  /** Submit a decision. Ignored until the active assistant has resolved. */
  decide: (requestId: string, action: GuardianDecisionAction) => void;
  /** True while a decision is in flight. */
  isPending: boolean;
  /** Whether a decision can be submitted at all. */
  canDecide: boolean;
  /** Every settled decision this session, by request id. */
  outcomes: ReadonlyMap<string, GuardianDecisionOutcome>;
  /** The requests whose outcome is terminal here; see `isTerminalDecision`. */
  decidedRequestIds: ReadonlySet<string>;
} {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const invalidateFeed = useInvalidateHomeFeed(assistantId);
  const outcomes = useGuardianDecisionStore.use.outcomes();

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
      useGuardianDecisionStore.getState().recordOutcome(settled);
      if (!settled.applied) {
        toastDeclinedDecision(settled.reason);
      }
      invalidateFeed();
    },
    onError: (error, variables) => {
      if (error instanceof ApiError && error.status === 404) {
        useGuardianDecisionStore.getState().recordOutcome({
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

  const decidedRequestIds = useMemo(() => {
    const ids = new Set<string>();
    for (const outcome of outcomes.values()) {
      if (isTerminalDecision(outcome)) {
        ids.add(outcome.requestId);
      }
    }
    return ids;
  }, [outcomes]);

  return {
    decide,
    isPending: decision.isPending,
    canDecide: assistantId !== null,
    outcomes,
    decidedRequestIds,
  };
}
