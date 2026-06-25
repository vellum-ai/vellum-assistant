/**
 * Archives the dedicated "Getting to know X" side conversation the
 * research-onboarding flow mints to run its behind-the-scenes research turn.
 *
 * That conversation is a throwaway side channel: it exists only to drive the
 * research prompt whose claims/suggestions the in-flow result steps render. It
 * must never surface in the user's chat sidebar when they land in their
 * workspace, so once the research response has settled we archive it — the
 * sidebar's `group-conversations.ts` drops `archivedAt != null` rows, so an
 * archived conversation simply disappears from the list.
 *
 * Best-effort: this runs after the response is delivered, so a failure here
 * must never block or surface in the flow. Every error is swallowed (reported
 * to Sentry) and never rethrown, mirroring `checkin-scheduler.ts`.
 */

import { conversationsByIdArchivePost } from "@/generated/daemon/sdk.gen";
import { captureError } from "@/lib/sentry/capture-error";

/**
 * Archive the research-onboarding side conversation so it never appears in the
 * chat sidebar. Best-effort and fire-and-forget: resolves regardless of outcome
 * and never throws.
 */
export async function archiveResearchConversation(
  assistantId: string,
  conversationId: string,
): Promise<void> {
  try {
    await conversationsByIdArchivePost({
      path: { assistant_id: assistantId, id: conversationId },
      throwOnError: false,
    });
  } catch (err) {
    captureError(err, { context: "research_onboarding_archive" });
  }
}
