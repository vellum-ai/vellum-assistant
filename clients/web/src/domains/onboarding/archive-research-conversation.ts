/**
 * Archives the dedicated "Getting to know X" side conversation the
 * research-onboarding flow mints to run its behind-the-scenes research turn.
 *
 * That conversation is a throwaway side channel: it exists only to drive the
 * research prompt whose claims/suggestions the in-flow result steps render. It
 * is minted `background`, which the daemon keeps out of the default `standard`
 * conversation list, so the sidebar never shows it. Archiving is cleanup on top
 * of that: it also drops the row from the lazily-loaded Background section.
 *
 * Best-effort: a failure here must never block or surface in the flow. Every
 * error is swallowed (reported to Sentry) and never rethrown, mirroring
 * `checkin-scheduler.ts`.
 */

import { conversationsByIdArchivePost } from "@/generated/daemon/sdk.gen";
import { captureError } from "@/lib/sentry/capture-error";

/**
 * Archive the research-onboarding side conversation. Best-effort and
 * fire-and-forget: resolves regardless of outcome and never throws.
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
