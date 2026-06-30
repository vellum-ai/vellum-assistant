/**
 * Posts a one-shot correction into the research-onboarding side conversation
 * when the user prunes — or rejects all of — the web-research claims on the
 * "This is what I found about you" step.
 *
 * SPIKE — research-onboarding flow.
 *
 * The research turn runs against the REAL hatched assistant, so what it learned
 * about the user lives in that assistant's memory (shared across all of its
 * conversations — see `archive-research-conversation.ts` for the side-channel
 * design). Removing a claim in the UI alone changes nothing: the assistant
 * still believes it and carries it into the real chat. This fires a
 * natural-language correction back into the same conversation so the assistant
 * disregards the wrong claims — or, when the user clicks "This is not me", the
 * ENTIRE search (a similar-name mismatch, the failure mode the step guards
 * against) — and doesn't treat any of it as true going forward.
 *
 * Best-effort and fire-and-forget, exactly like `archive-research-conversation`
 * and `checkin-scheduler`: a failure here must never block or surface in the
 * flow. Talks to the daemon through the generated SDK directly
 * (`@/domains/chat/api/*` is import-banned from onboarding), mirroring the
 * research runner that minted this conversation.
 *
 * The conversation was archived once research settled; posting a message can
 * resurface it in the sidebar, so we re-archive afterwards (idempotent,
 * best-effort) to keep the throwaway side channel hidden.
 */

import { messagesPost } from "@/generated/daemon/sdk.gen";
import type { MessagesPostData } from "@/generated/daemon/types.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { detectClientOs } from "@/runtime/platform-detection";
import { archiveResearchConversation } from "@/domains/onboarding/archive-research-conversation";

export interface ResearchCorrection {
  /** The claims the user X'd out (their exact `claim` text). */
  removedClaims: string[];
  /**
   * The user clicked "This is not me" — the whole search matched someone else.
   * Disregard everything it found, not just the listed claims.
   */
  rejectedAll: boolean;
}

/**
 * Build the correction message, or `null` when there's nothing to correct (no
 * claims removed and not a full rejection). Pure so it's unit-testable without
 * mocking the SDK.
 */
export function buildResearchCorrection({
  removedClaims,
  rejectedAll,
}: ResearchCorrection): string | null {
  if (rejectedAll) {
    return [
      "Correction: none of what you found in that web search is actually me —",
      "it looks like you matched someone else with a similar name. Please",
      "disregard everything from that search and don't remember any of it as",
      "true about me. We'll build up what you actually know about me from here,",
      "as we talk.",
    ].join(" ");
  }
  const cleaned = removedClaims.map((c) => c.trim()).filter(Boolean);
  if (cleaned.length === 0) return null;
  return [
    "Quick correction on what you found about me — these aren't true, so please",
    "disregard them and don't remember them as facts about me:",
    "",
    ...cleaned.map((c) => `- ${c}`),
  ].join("\n");
}

export interface SendResearchCorrectionOptions extends ResearchCorrection {
  assistantId: string;
  /** The research side conversation the claims came from. */
  conversationId: string;
}

/**
 * Fire the correction into the research conversation. Resolves regardless of
 * outcome and never throws; a no-op (resolves immediately) when there's nothing
 * to correct.
 */
export async function sendResearchCorrection({
  assistantId,
  conversationId,
  removedClaims,
  rejectedAll,
}: SendResearchCorrectionOptions): Promise<void> {
  const content = buildResearchCorrection({ removedClaims, rejectedAll });
  if (!content) return;
  try {
    const body: MessagesPostData["body"] = {
      conversationId,
      content,
      sourceChannel: "vellum",
      // `interface` is the transport ("web"); the real OS travels in `clientOs`
      // so the correction turn keeps the assistant's `client_os` context too,
      // matching the initial research send (`research-runner.ts`).
      interface: "web",
      clientOs: detectClientOs(),
      clientMessageId: crypto.randomUUID(),
    };
    await messagesPost({
      path: { assistant_id: assistantId },
      body,
      throwOnError: false,
    });
  } catch (err) {
    captureError(err, { context: "research_onboarding_correction" });
  }
  // Keep the throwaway side conversation out of the sidebar even if posting
  // resurfaced it. Best-effort and already-swallowed by the helper.
  await archiveResearchConversation(assistantId, conversationId);
}
