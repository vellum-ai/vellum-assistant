/**
 * Contact-prompt interaction handlers.
 *
 * Stateless imperative functions — no React hooks, no component state.
 * Each reads store state via `.getState()` and coordinates the
 * submit/cancel lifecycle for the contact-request interaction.
 */

import { captureError } from "@/lib/sentry/capture-error";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useStreamStore } from "@/domains/chat/stream-store";
import { useConversationStore } from "@/stores/conversation-store";
import { endTurn } from "@/domains/chat/turn-coordinator";
import { submitContactPrompt } from "@/domains/chat/api/interactions";

/**
 * Submit the contact address/channel to the daemon.
 * Optimistically dismisses the prompt after a 1.5 s delay (matching macOS).
 */
export async function handleContactPromptSubmit(address: string, channelType: string): Promise<void> {
  const { pendingContactRequest, isSubmittingContactRequest } = useInteractionStore.getState();
  if (!pendingContactRequest || isSubmittingContactRequest) return;
  useInteractionStore.getState().submitContactRequestStart();
  useChatSessionStore.getState().setError(null);

  const ctx = useStreamStore.getState().streamContext;
  if (!ctx) {
    useChatSessionStore.getState().setError({ message: "No active session. Please try again." });
    useInteractionStore.getState().submitContactRequestEnd();
    return;
  }

  try {
    const result = await submitContactPrompt(
      ctx.assistantId,
      pendingContactRequest.requestId,
      address,
      channelType,
      pendingContactRequest.role,
    );
    if (!result.ok) {
      useChatSessionStore.getState().setError({ message: result.error });
      useInteractionStore.getState().submitContactRequestEnd();
      return;
    }

    useInteractionStore.getState().acceptContactRequest();
    const savedRequestId = pendingContactRequest.requestId;
    setTimeout(() => {
      const current = useInteractionStore.getState().pendingContactRequest;
      if (current?.requestId === savedRequestId) {
        useInteractionStore.getState().dismissContactRequest();
      }
    }, 1500);
  } catch (err) {
    captureError(err, { context: "submit_contact_prompt" });
    useChatSessionStore.getState().setError({ message: "Failed to save contact. Please try again." });
    useInteractionStore.getState().submitContactRequestEnd();
  }
}

/**
 * Cancel the contact prompt — dismisses local state and ends the turn.
 */
export function handleContactPromptCancel(): void {
  useInteractionStore.getState().dismissContactRequest();
  endTurn({
    conversationId: useConversationStore.getState().activeConversationId,
    reason: "error",
  });
}
