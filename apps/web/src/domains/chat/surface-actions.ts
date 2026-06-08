/**
 * Surface-action interaction handler.
 *
 * Stateless imperative function — no React hooks, no component state.
 * Coordinates submitting a user action on a dynamic surface (form, button, etc.)
 * rendered within the chat transcript.
 */

import { captureError } from "@/lib/sentry/capture-error";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useStreamStore } from "@/domains/chat/stream-store";
import { useTurnStore } from "@/domains/chat/turn-store";
import { completeSubmittedSurface } from "@/domains/chat/utils/send-message-utils";
import { submitSurfaceAction } from "@/domains/chat/api/surfaces";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile";

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
  const exists = useChatSessionStore.getState().messages.some((m) =>
    m.surfaces?.some((s) => s.surfaceId === surfaceId),
  );
  if (!exists) {
    console.warn(`Surface action on unknown surface: ${surfaceId}`);
    return;
  }

  const ctx = useStreamStore.getState().streamContext;
  if (!ctx) {
    useChatSessionStore.getState().setError({ message: "No active session. Please try again." });
    return;
  }

  let result: { ok: boolean };
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

  useTurnStore.getState().requestSend();

  useChatSessionStore.getState().setMessages((prev: DisplayMessage[]) =>
    completeSubmittedSurface(prev, surfaceId, actionId),
  );
}
