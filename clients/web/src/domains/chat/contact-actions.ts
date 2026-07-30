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
import { submitContactPrompt, submitContactMerge } from "@/domains/chat/api/interactions";
import type { SubmitSecretResponseResult } from "@/domains/chat/api/interactions";

/**
 * Shared submit lifecycle for both prompt modes (address entry and merge
 * confirmation): guards on an active pending request, requires a live
 * stream session, and optimistically dismisses the prompt 1.5 s after a
 * successful submit (matching macOS).
 */
async function runContactPromptSubmission(
  submit: (assistantId: string, requestId: string) => Promise<SubmitSecretResponseResult>,
  failureMessage: string,
  sentryContext: string,
): Promise<void> {
  const { pendingContactRequest, isSubmittingContactRequest } = useInteractionStore.getState();
  if (!pendingContactRequest || isSubmittingContactRequest) {
    return;
  }
  useInteractionStore.getState().submitContactRequestStart();
  useChatSessionStore.getState().setError(null);

  const ctx = useStreamStore.getState().streamContext;
  if (!ctx) {
    useChatSessionStore
      .getState()
      .setError({ message: "No active session. Please try again." });
    useInteractionStore.getState().submitContactRequestEnd();
    return;
  }

  try {
    const result = await submit(ctx.assistantId, pendingContactRequest.requestId);
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
    captureError(err, { context: sentryContext });
    useChatSessionStore.getState().setError({ message: failureMessage });
    useInteractionStore.getState().submitContactRequestEnd();
  }
}

/**
 * Submit the contact address/channel to the daemon.
 */
export async function handleContactPromptSubmit(address: string, channelType: string): Promise<void> {
  await runContactPromptSubmission(
    (assistantId, requestId) =>
      submitContactPrompt(
        assistantId,
        requestId,
        address,
        channelType,
        useInteractionStore.getState().pendingContactRequest?.role,
      ),
    "Failed to save contact. Please try again.",
    "submit_contact_prompt",
  );
}

/**
 * Confirm a pending contact-merge prompt. The guardian's confirmation is
 * relayed to the daemon, which performs the merge itself.
 */
export async function handleContactMergeConfirm(): Promise<void> {
  await runContactPromptSubmission(
    (assistantId, requestId) => submitContactMerge(assistantId, requestId),
    "Failed to merge contacts. Please try again.",
    "submit_contact_merge_confirm",
  );
}

/**
 * Cancel the contact prompt — dismisses local state and ends the turn.
 * Applies to both address-entry and merge-confirmation prompts; neither
 * mode notifies the gateway/daemon on cancel (the pending prompt times out
 * server-side if never resolved).
 */
export function handleContactPromptCancel(): void {
  useInteractionStore.getState().dismissContactRequest();
  endTurn({
    conversationId: useConversationStore.getState().activeConversationId,
    reason: "error",
  });
}
