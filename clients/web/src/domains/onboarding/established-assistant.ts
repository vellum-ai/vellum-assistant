/**
 * Detects whether the assistant the research-onboarding flow is about to run
 * against is already established — it has lived conversations — so the flow
 * can offer an explicit off-ramp instead of silently re-onboarding (and
 * rewriting the persona of) an assistant the user already customized.
 *
 * Conversation history is the establishment signal: a fresh hatch has none,
 * and the flow's own side conversations (research, personality) are archived
 * once they settle, so they don't count against a genuinely-new user who
 * abandoned a prior attempt. The identity name is fetched only for the guard
 * screen's copy and is best-effort.
 *
 * Fail-open: a genuine fetch failure treats the assistant as fresh — the
 * guard exists to stop silent persona rewrites of real assistants, not to
 * block onboarding when the daemon hiccups.
 */

import { fetchAssistantIdentity } from "@/assistant/identity";
import { captureError } from "@/lib/sentry/capture-error";
import { hasAnyActiveConversation } from "@/utils/conversation-list-fetchers";

export interface EstablishedAssistantCheck {
  established: boolean;
  /** Current assistant name for the guard screen's copy; null when unknown. */
  assistantName: string | null;
}

/** The no-gate verdict: a fresh assistant (or an undeterminable one). */
export const FRESH_ASSISTANT_CHECK: EstablishedAssistantCheck = {
  established: false,
  assistantName: null,
};

interface CheckDeps {
  hasAnyActiveConversation: typeof hasAnyActiveConversation;
  fetchAssistantIdentity: typeof fetchAssistantIdentity;
}

/**
 * Resolve the guard verdict for the hatched assistant. Deps are injectable for
 * tests; production callers use the defaults.
 */
export async function checkEstablishedAssistant(
  assistantId: string,
  deps: CheckDeps = { hasAnyActiveConversation, fetchAssistantIdentity },
): Promise<EstablishedAssistantCheck> {
  try {
    if (!(await deps.hasAnyActiveConversation(assistantId))) {
      return FRESH_ASSISTANT_CHECK;
    }
  } catch (err) {
    captureError(err, { context: "research_onboarding_established_check" });
    return FRESH_ASSISTANT_CHECK;
  }
  // Established — pull the current name so the guard screen can say who it is
  // protecting. Best-effort and isolated from the verdict: a positive
  // has-history signal gates even when the identity lookup fails.
  const identity = await deps
    .fetchAssistantIdentity(assistantId)
    .catch(() => null);
  const name = typeof identity?.name === "string" ? identity.name.trim() : "";
  return { established: true, assistantName: name || null };
}
