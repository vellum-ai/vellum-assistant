/**
 * Whether a pending confirmation offers a durable allow rule.
 *
 * Two surfaces render a confirmation: the inline card on a tool-call chip and
 * the transcript's trailer row. Which one a given prompt lands on depends on
 * whether its tool call is in the transcript, which is invisible to the user,
 * so the choices offered must not depend on it. One predicate, every surface,
 * including the submit path that decides whether to send a rule hint.
 */

import type { AllowlistOption } from "@/types/interaction-ui-types";

/** The payload fields the answer is derived from. */
export interface RuleOptionSource {
  allowlistOptions?: AllowlistOption[];
  persistentDecisionsAllowed?: boolean;
}

export function offersRuleOption(confirmation: RuleOptionSource): boolean {
  // A tool that demanded fresh approval every time (scheduled tasks, workflow
  // management) ships `persistentDecisionsAllowed: false` while still carrying
  // allowlist options, since the generator's fallback is "Everything".
  // Offering the rule there invites the standing permission the daemon asked
  // to prevent.
  return (
    confirmation.persistentDecisionsAllowed !== false &&
    (confirmation.allowlistOptions?.length ?? 0) > 0
  );
}
