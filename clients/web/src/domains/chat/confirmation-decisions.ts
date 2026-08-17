/**
 * What a pending confirmation offers the user, derived once.
 *
 * Two surfaces render a confirmation: the inline card on a tool-call chip and
 * the transcript's trailer row. Which one a given prompt lands on depends on
 * whether its tool call is in the transcript, which is invisible to the user,
 * so the choices offered must not depend on it. One derivation, both surfaces.
 *
 * This is the decision set and not a rendering: the two surfaces draw it
 * differently (the chip follows the Figma card, the trailer row keeps its own
 * chrome), which is a visual decision and not this one's to make.
 *
 * `confirmLabel`/`denyLabel` are latent. Nothing in the daemon populates them
 * for a tool approval: they are absent from the `confirmation_request` event
 * and from `PendingToolConfirmationSchema`, so every prompt resolves to the
 * defaults below. They stay here because the client type and its parser
 * already carry the fields, and one defaulting site is better than two if a
 * producer ever appears.
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
