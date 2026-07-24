/**
 * Completion tone for a resolved surface card — the icon + color shown once a
 * card is done. One tone is derived two ways that must agree:
 *
 * - {@link guardianDecisionTone} from the action the guardian took (the
 *   optimistic path, where the client knows the action it just submitted), and
 * - {@link inferCompletionTone} from the completion summary string (the SSE
 *   `ui_surface_complete` path and history-restored cards, which carry only the
 *   label).
 *
 * Keeping both here makes their agreement explicit: a `leave_unverified` park
 * and its "Left unverified" summary both resolve to `neutral`; a `block`/deny
 * and its "Denied"/"Blocked" summary both resolve to `danger`.
 */

import type { SurfaceCompletionTone } from "@/domains/chat/types/types";

/** Guardian-decision actions that resolve a request to a denied state. */
const DENY_DECISION_ACTIONS: ReadonlySet<string> = new Set([
  "reject",
  "leave_unverified",
  "block",
]);

/**
 * Denying actions that *park* the contact at `unverified` — a neutral hold, not
 * an active rejection. Mirrors the daemon's `PARK_ACTION_SET`: a parked contact
 * is neither trusted nor kept out, so the card reads neutral. `block`/`reject`
 * stay `danger`.
 */
const PARK_DECISION_ACTIONS: ReadonlySet<string> = new Set(["leave_unverified"]);

/** Action segment of an `apr:<requestId>:<action>` guardian-decision id. */
function guardianDecisionAction(actionId: string): string {
  return actionId.startsWith("apr:")
    ? actionId.split(":").slice(2).join(":")
    : actionId;
}

/**
 * Completion tone for a guardian decision (apr:*): a decision that didn't apply
 * (already resolved, expired, …) is a neutral non-affirmative state; an applied
 * park (leave-unverified) is also neutral (the contact is held, not rejected);
 * an applied deny/block is a rejection (danger); an applied approve/trust is a
 * success. This keeps the completed card's icon from showing an affirmative
 * green check on a denial, or a red rejection cross on a neutral park.
 */
export function guardianDecisionTone(
  actionId: string,
  result: { applied?: boolean },
): SurfaceCompletionTone {
  if (result.applied === false) {
    return "neutral";
  }
  const action = guardianDecisionAction(actionId);
  if (PARK_DECISION_ACTIONS.has(action)) {
    return "neutral";
  }
  return DENY_DECISION_ACTIONS.has(action) ? "danger" : "success";
}

/**
 * Infer a completion tone from the summary text. Used when no explicit
 * `completionTone` was set (the SSE `ui_surface_complete` path and
 * history-restored surfaces carry only the summary string). Covers the daemon's
 * terminal-status labels ("Denied", "Left unverified", "Expired", …) and the
 * guardian-decision reason labels; anything unrecognized stays `success` so
 * ordinary completed cards keep their affirmative check.
 */
export function inferCompletionTone(
  summary: string | undefined,
): SurfaceCompletionTone {
  if (!summary) {
    return "success";
  }
  const s = summary.toLowerCase();
  if (/denied|declined|rejected|blocked/.test(s)) {
    return "danger";
  }
  if (
    /unverified|expired|cancel|timed out|resolved|not applied|not authorized|not found|failed/.test(
      s,
    )
  ) {
    return "neutral";
  }
  return "success";
}
