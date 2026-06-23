/**
 * Removal-correction follow-up for the research-onboarding results step.
 *
 * SPIKE — research-onboarding flow.
 *
 * Lives in the chat domain (next to the overlay that sends this) rather than
 * with the initial prompt in `@/domains/onboarding`, to respect domain
 * boundaries. Shares the `{ claims, suggestions }` output contract documented
 * in `@/domains/onboarding/research-prompt.ts`.
 *
 * `buildRemovalNote` folds in the claims the user removed (with optional
 * reason) into a fire-and-forget correction sent when the user continues out
 * of the results overlay, so the assistant stops treating the wrong claims as
 * true in the rest of the conversation.
 */

import {
  REMOVAL_REASON_LABELS,
  type RemovalReason,
} from "@/domains/chat/onboarding-research/research-facts";

export interface RemovedClaim {
  claim: string;
  reason: RemovalReason | null;
}

function formatRemoved(removed: RemovedClaim[]): string {
  return removed
    .map((r) => {
      const label = r.reason ? REMOVAL_REASON_LABELS[r.reason].toLowerCase() : null;
      return `- ${r.claim}${label ? ` (${label})` : ""}`;
    })
    .join("\n");
}

/** Fire-and-forget correction sent when the user accepts the current result. */
export function buildRemovalNote(removed: RemovedClaim[]): string {
  return [
    "Quick correction on what you found about me — please disregard these and",
    "don't treat them as true:",
    "",
    formatRemoved(removed),
  ].join("\n");
}
