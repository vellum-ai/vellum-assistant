/**
 * Secret-prompt interaction handlers.
 *
 * Stateless imperative functions — no React hooks, no component state.
 * Each reads store state via `.getState()` and coordinates the
 * submit/cancel lifecycle for the secret-prompt interaction.
 */

import { captureError } from "@/lib/sentry/capture-error";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useStreamStore } from "@/domains/chat/stream-store";
import { useConversationStore } from "@/stores/conversation-store";
import { endTurn } from "@/domains/chat/turn-coordinator";
import { submitSecretResponse } from "@/domains/chat/api/interactions";

/**
 * Submit the user-provided secret value to the daemon.
 * Optimistically dismisses the prompt after a 1.5 s delay (matching macOS).
 */
export async function handleSecretSubmit(value: string, delivery: string = "store"): Promise<void> {
  const { pendingSecret, isSubmittingSecret } = useInteractionStore.getState();
  if (!pendingSecret || isSubmittingSecret) return;
  useInteractionStore.getState().submitSecretStart();
  useChatSessionStore.getState().setError(null);

  const ctx = useStreamStore.getState().streamContext;
  if (!ctx) {
    useChatSessionStore.getState().setError({ message: "No active session. Please try again." });
    useInteractionStore.getState().submitSecretEnd();
    return;
  }

  try {
    const result = await submitSecretResponse(
      ctx.assistantId,
      pendingSecret.requestId,
      value,
      delivery,
    );
    if (!result.ok) {
      useChatSessionStore.getState().setError({ message: result.error });
      useInteractionStore.getState().submitSecretEnd();
      return;
    }

    useInteractionStore.getState().submitSecretEnd(true);
    const convKey = useConversationStore.getState().activeConversationId;
    if (convKey) {
      useConversationStore.getState().removeAttentionConversationId(convKey);
    }
    const savedRequestId = pendingSecret.requestId;
    setTimeout(() => {
      const current = useInteractionStore.getState().pendingSecret;
      if (current?.requestId === savedRequestId) {
        useInteractionStore.getState().dismissSecret();
      }
    }, 1500);
  } catch (err) {
    captureError(err, { context: "submit_secret" });
    useChatSessionStore.getState().setError({ message: "Failed to submit secret. Please try again." });
    useInteractionStore.getState().submitSecretEnd();
  }
}

/**
 * Cancel the secret prompt — sends an empty "none" delivery to the daemon
 * so the turn can end gracefully, then clears local state.
 */
export function handleSecretCancel(): void {
  const ctx = useStreamStore.getState().streamContext;
  const requestId = useInteractionStore.getState().pendingSecret?.requestId;
  if (ctx && requestId) {
    submitSecretResponse(ctx.assistantId, requestId, "", "none").catch(() => {});
  }
  useInteractionStore.getState().dismissSecret();
  const convKey = useConversationStore.getState().activeConversationId;
  if (convKey) {
    useConversationStore.getState().removeAttentionConversationId(convKey);
  }
  endTurn({ conversationId: convKey, reason: "error" });
}
