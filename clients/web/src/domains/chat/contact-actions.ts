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
/** Whether this submission still holds the contact-request slot. See
 *  `stillOwnsConfirmationState` in `confirmation-actions.ts`. */
function stillOwnsContactRequestState(requestId: string): boolean {
  return (
    useInteractionStore.getState().submittingContactRequestRequestId ===
    requestId
  );
}

export async function handleContactPromptSubmit(
  address: string,
  channelType: string,
): Promise<void> {
  const { pendingContactRequest, submittingContactRequestRequestId } =
    useInteractionStore.getState();
  // Guards double-submitting this prompt, not any prompt.
  if (
    !pendingContactRequest ||
    submittingContactRequestRequestId === pendingContactRequest.requestId
  ) {
    return;
  }
  useInteractionStore
    .getState()
    .submitContactRequestStart(pendingContactRequest.requestId);
  useChatSessionStore.getState().setError(null);

  const ctx = useStreamStore.getState().streamContext;
  if (!ctx) {
    useChatSessionStore
      .getState()
      .setError({ message: "No active session. Please try again." });
    useInteractionStore
      .getState()
      .submitContactRequestEnd(pendingContactRequest.requestId);
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
      if (stillOwnsContactRequestState(pendingContactRequest.requestId)) {
        useChatSessionStore.getState().setError({ message: result.error });
        useInteractionStore
          .getState()
          .submitContactRequestEnd(pendingContactRequest.requestId);
      }
      return;
    }

    useInteractionStore.getState().acceptContactRequest();
    const savedRequestId = pendingContactRequest.requestId;
    setTimeout(() => {
      useInteractionStore
        .getState()
        .dismissContactRequestIfMatches(savedRequestId);
    }, 1500);
  } catch (err) {
    captureError(err, { context: "submit_contact_prompt" });
    if (!stillOwnsContactRequestState(pendingContactRequest.requestId)) {
      return;
    }
    useChatSessionStore
      .getState()
      .setError({ message: "Failed to save contact. Please try again." });
    useInteractionStore
      .getState()
      .submitContactRequestEnd(pendingContactRequest.requestId);
  }
}

/**
 * Cancel the contact prompt — dismisses local state and ends the turn.
 */
export function handleContactPromptCancel(): void {
  const requestId =
    useInteractionStore.getState().pendingContactRequest?.requestId;
  if (requestId) {
    useInteractionStore.getState().dismissContactRequestIfMatches(requestId);
  }
  endTurn({
    conversationId: useConversationStore.getState().activeConversationId,
    reason: "error",
  });
}
