/**
 * Background follow-up messages for the research-onboarding results step.
 *
 * SPIKE — research-onboarding flow.
 *
 * Lives in the chat domain (next to the overlay that sends these) rather than
 * with the initial prompt in `@/domains/onboarding`, to respect domain
 * boundaries. Shares the `{ claims, suggestions }` output contract documented
 * in `@/domains/onboarding/research-prompt.ts`.
 *
 * Both builders fold in the claims the user removed (with optional reason) so
 * the assistant learns what was wrong — `buildDeeperDivePrompt` when the user
 * digs deeper (also asks for a richer, overwriting result), `buildRemovalNote`
 * as a fire-and-forget correction when the user accepts what's there.
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

const REMOVED_PREAMBLE =
  "I removed these — they're not accurate about me, so disregard them:";

export function buildDeeperDivePrompt(removed: RemovedClaim[] = []): string {
  const lines: string[] = [];
  if (removed.length > 0) {
    lines.push(REMOVED_PREAMBLE, formatRemoved(removed), "");
  }
  lines.push(
    "Go deeper. Run more searches and read further to sharpen what you know",
    "about me — confirm the uncertain guesses, correct anything off, and find",
    "more specific, useful details.",
    "",
    'Reply with ONLY the same JSON object as before ({ "claims": [...],',
    '"suggestions": [...] }), updated and overwritten with what you now know.',
    "Follow exactly the same claim and suggestion rules as my original research",
    "request above — same shape, same confidence tiers, the same 4 suggestion",
    "slots in the same order, no prose, no code fence.",
  );
  return lines.join("\n");
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
