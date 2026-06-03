import type { PreChatOnboardingContext } from "@/domains/onboarding/prechat";

/** Stable id of the inbox-cleanup first task. Matches skills/inbox-cleanup. */
export const INBOX_CLEANUP_TASK_ID = "inbox-cleanup" as const;

/**
 * The activation decision-engine seam.
 *
 * v1 (this spike): ignores context and always returns the inbox-cleanup
 * constant. In vN this consults real context (selected tasks/tools,
 * connected providers, cohort) and selects. Same rail, this one node
 * changes — intentionally NOT throwaway.
 */
export function chooseFirstTask(
  _context: PreChatOnboardingContext,
): string {
  return INBOX_CLEANUP_TASK_ID;
}
