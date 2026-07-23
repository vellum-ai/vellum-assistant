/**
 * Shared contract for the first-run scope options offered by the "Let's chat"
 * kickoff greeting (see `lets-chat-kickoff.ts`).
 *
 * These are wire values: they ride `ui_show` choice-option `data` payloads
 * through the daemon and come back on click as the surface action's data.
 * Downstream consumers (e.g. click telemetry in the chat domain) match on
 * them, so they must stay stable — do not rename or reorder.
 *
 * Chat-domain code may import this module; the import direction mirrors
 * `PreChatOnboardingContext` in `prechat.ts` — onboarding exports, other
 * domains import.
 */
export const FIRST_RUN_SCOPE_DATA_KEY = "firstRunScope";
export const FIRST_RUN_SCOPES = ["work", "personal", "both"] as const;
export type FirstRunScope = (typeof FIRST_RUN_SCOPES)[number];
export const FIRST_RUN_SCOPE_OPTION_IDS: Record<FirstRunScope, string> = {
  work: "scope_work",
  personal: "scope_personal",
  both: "scope_both",
};
