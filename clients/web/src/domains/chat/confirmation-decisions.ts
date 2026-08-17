/**
 * What a pending confirmation offers the user, derived once.
 *
 * Two surfaces render a confirmation: the inline card on a tool-call chip and
 * the transcript's trailer row. Which one a given prompt lands on depends on
 * whether its tool call is in the transcript, which is invisible to the user,
 * so the choices they are given must not depend on it. Each surface deriving
 * its own set from the raw payload is how they came to disagree: one honoured
 * `confirmLabel`/`denyLabel` and the other hardcoded the verbs, one gated the
 * rule option on `persistentDecisionsAllowed` and the other ignored it.
 *
 * This is deliberately the decision set and not a rendering: the two surfaces
 * still draw it differently (the chip follows the Figma card, the trailer row
 * keeps its own chrome), and converging that is a visual decision, not this
 * one.
 */

import type { AllowlistOption } from "@/types/interaction-ui-types";

/** The payload fields a decision set is derived from. */
export interface ConfirmationDecisionSource {
  confirmLabel?: string;
  denyLabel?: string;
  allowlistOptions?: AllowlistOption[];
  persistentDecisionsAllowed?: boolean;
}

export interface ConfirmationDecisions {
  /** Verb for the approve action. */
  confirmLabel: string;
  /** Verb for the reject action. */
  denyLabel: string;
  /**
   * Whether to offer creating a durable allow rule alongside the one-off
   * approval.
   */
  offersRule: boolean;
}

export const DEFAULT_CONFIRM_LABEL = "Allow";
export const DEFAULT_DENY_LABEL = "Deny";

export function resolveConfirmationDecisions(
  confirmation: ConfirmationDecisionSource,
): ConfirmationDecisions {
  return {
    confirmLabel: confirmation.confirmLabel || DEFAULT_CONFIRM_LABEL,
    denyLabel: confirmation.denyLabel || DEFAULT_DENY_LABEL,
    // A tool that demanded fresh approval every time (scheduled tasks,
    // workflow management) ships `persistentDecisionsAllowed: false` while
    // still carrying allowlist options, since the generator's fallback is
    // "Everything". Offering the rule there invites the standing permission
    // the daemon asked to prevent.
    offersRule:
      confirmation.persistentDecisionsAllowed !== false &&
      (confirmation.allowlistOptions?.length ?? 0) > 0,
  };
}
