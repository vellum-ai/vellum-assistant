/**
 * Surface-action interaction handler.
 *
 * Stateless imperative function — no React hooks, no component state.
 * Coordinates submitting a user action on a dynamic surface (form, button, etc.)
 * rendered within the chat transcript.
 */

import { captureError } from "@/lib/sentry/capture-error";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { patchTranscriptMessages } from "@/domains/chat/transcript/patch-transcript-messages";
import { useStreamStore } from "@/domains/chat/stream-store";
import { useTurnStore } from "@/domains/chat/turn-store";
import { completeSubmittedSurface } from "@/domains/chat/utils/send-message-utils";
import { submitSurfaceAction } from "@/domains/chat/api/surfaces";
import type { DisplayMessage } from "@/domains/chat/types/types";

const DECISION_REASON_LABELS: Record<string, string> = {
  already_resolved: "Already resolved",
  expired: "Request expired",
  identity_mismatch: "Not authorized",
  not_found: "Request not found",
  resolver_failed: "Action failed",
};

function formatDecisionReason(reason?: string): string {
  if (!reason) return "Not applied";
  return DECISION_REASON_LABELS[reason] ?? "Not applied";
}

/**
 * Submit a user action on a rendered surface (e.g. form submit, button click).
 * Validates the surface exists, sends the action to the daemon, marks the
 * surface as submitted locally, and signals the turn store to expect a reply.
 */
export async function handleSurfaceAction(
  surfaceId: string,
  actionId: string,
  data?: Record<string, unknown>,
): Promise<void> {
  // The caller only renders an actionable surface that's in the transcript, and
  // the daemon validates the surface id on submit (a stale/unknown id comes back
  // `not_found`, handled below) — so no client-side existence pre-check.
  const ctx = useStreamStore.getState().streamContext;
  if (!ctx) {
    useChatSessionStore.getState().setError({ message: "No active session. Please try again." });
    return;
  }

  let result: Awaited<ReturnType<typeof submitSurfaceAction>>;
  try {
    result = await submitSurfaceAction(
      ctx.assistantId,
      surfaceId,
      actionId,
      data,
    );
  } catch (err) {
    captureError(err, { context: "submit_surface_action" });
    useChatSessionStore.getState().setError({ message: "Failed to submit. Please try again." });
    return;
  }

  if (!result.ok) {
    useChatSessionStore.getState().setError({ message: "Failed to submit. Please try again." });
    return;
  }

  // Guardian decision actions (apr:*) are processed synchronously at the
  // HTTP handler level — no conversation turn is started, so no SSE events
  // will arrive to complete the turn. Only request a send for actions that
  // trigger daemon-side conversation processing.
  const isGuardianDecision = typeof result.applied === "boolean";
  if (!isGuardianDecision) {
    useTurnStore.getState().requestSend();
  }

  const completionText =
    isGuardianDecision && result.applied === false
      ? formatDecisionReason(result.reason)
      : result.replyText;

  patchTranscriptMessages((prev: DisplayMessage[]) =>
    completeSubmittedSurface(prev, surfaceId, actionId, completionText),
  );
}
