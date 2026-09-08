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
 * The daemon's reason for a decision it recorded whose follow-through then
 * failed. Whether it was recorded is read off the response's own
 * `committed` field rather than off this reason: an older daemon reports a
 * persist that never landed under the same reason, without the field, and
 * that decision has to stay retryable.
 */
const RESOLVER_FAILED_REASON = "resolver_failed";

export function isRetiredDecisionReason(reason: string | undefined): boolean {
  return reason !== undefined && RETIRED_REASONS.has(reason);
}

/** Whether the daemon recorded the decision, whatever happened after. */
export function isCommittedDecision(outcome: GuardianDecisionOutcome): boolean {
  return outcome.committed;
}

/**
 * Whether the request is settled as far as this client is concerned: the
 * decision was recorded, or the request turned out to be nobody's to decide.
 * Every other outcome (this actor may not decide it, the record is unusable,
 * the persist never landed) leaves the request pending and its buttons in
 * place.
 */
export function isTerminalDecision(outcome: GuardianDecisionOutcome): boolean {
  return (
    isCommittedDecision(outcome) || isRetiredDecisionReason(outcome.reason)
  );
}

/**
 * Say what happened to a decision the daemon declined, in the outcome's own
 * terms. A retired request is news rather than a failure; a decision that
 * was recorded but not followed through, one this actor may not make, or
 * one that did not take is a failure the user has to hear, so as not to
 * retry a click that cannot succeed, or so as to retry one that can.
 */
function toastDeclinedDecision(outcome: GuardianDecisionOutcome): void {
  if (outcome.committed) {
    toast.error(t("home:notificationsBell.decisionFollowThroughFailed"));
    return;
  }
  switch (outcome.reason) {
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
      // `request_misconfigured`, `decision_not_persisted`, an older daemon's
      // undifferentiated `resolver_failed`, and anything a newer daemon
      // adds: the decision did not take, and the row stays.
      toast.error(t("home:notificationsBell.decisionNotApplied"));
  }
}

/**
 * Whether a declined decision was nonetheless recorded. Only the daemon's
 * own `committed` field says so; a `resolver_failed` without it comes from
 * a daemon that also reports a failed persist that way, so it is read as
 * not recorded and the request stays retryable.
 */
function wasCommitted(data: {
  applied: boolean;
  reason?: string;
  committed?: boolean;
}): boolean {
  if (data.applied) {
    return true;
  }
  return data.reason === RESOLVER_FAILED_REASON && data.committed === true;
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
 * keep a settled request's buttons down until the feed catches up. The
 * in-flight request is shared the same way (`pendingRequestIds`), so a
 * request being decided from one surface cannot be decided again from
 * another before the first answer lands.
 *
 * A 200 that declined the decision carries a reason, which is recorded as
 * the outcome and explained by a toast; a 404 means the request is gone and
 * is folded into the same shape as the `not_found` reason. Any other failure
 * is captured and reported as a submission failure, with nothing recorded.
 */
export function useGuardianDecision(): {
  /** Submit a decision. Ignored until the active assistant has resolved. */
  decide: (requestId: string, action: GuardianDecisionAction) => void;
  /** True while a decision from this surface is in flight. */
  isPending: boolean;
  /** Whether a decision can be submitted at all. */
  canDecide: boolean;
  /** Every settled decision this session, by request id. */
  outcomes: ReadonlyMap<string, GuardianDecisionOutcome>;
  /** Requests with a decision in flight, from any surface. */
  pendingRequestIds: ReadonlySet<string>;
  /** The requests whose outcome is terminal here; see `isTerminalDecision`. */
  decidedRequestIds: ReadonlySet<string>;
} {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const invalidateFeed = useInvalidateHomeFeed(assistantId);
  const outcomes = useGuardianDecisionStore.use.outcomes();
  const pendingRequestIds = useGuardianDecisionStore.use.pendingRequestIds();

  const decision = useGuardianactionsDecisionPostMutation({
    onSuccess: (data, variables) => {
      const settled: GuardianDecisionOutcome = {
        requestId: variables.body.requestId,
        // The wire type is an open string; `decide` below only ever sends
        // one of the two actions.
        action: variables.body.action as GuardianDecisionAction,
        committed: wasCommitted(data),
        applied: data.applied,
        reason: data.reason,
      };
      useGuardianDecisionStore.getState().recordOutcome(settled);
      if (!settled.applied) {
        toastDeclinedDecision(settled);
      }
      invalidateFeed();
    },
    onError: (error, variables) => {
      if (error instanceof ApiError && error.status === 404) {
        const gone: GuardianDecisionOutcome = {
          requestId: variables.body.requestId,
          action: variables.body.action as GuardianDecisionAction,
          committed: false,
          applied: false,
          reason: "not_found",
        };
        useGuardianDecisionStore.getState().recordOutcome(gone);
        toastDeclinedDecision(gone);
        invalidateFeed();
        return;
      }
      captureError(error, { context: "guardian-decision" });
      toast.error(t("home:homeGuardianRequestCard.decisionFailed"));
    },
    onSettled: (_data, _error, variables) => {
      useGuardianDecisionStore
        .getState()
        .clearPending(variables.body.requestId);
    },
  });

  const { mutate } = decision;
  const decide = useCallback(
    (requestId: string, action: GuardianDecisionAction) => {
      if (!assistantId) {
        return;
      }
      useGuardianDecisionStore.getState().markPending(requestId);
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
    pendingRequestIds,
    decidedRequestIds,
  };
}
