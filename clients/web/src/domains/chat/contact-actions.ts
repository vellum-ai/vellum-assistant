/**
 * Contact-prompt interaction handlers.
 *
 * Stateless imperative functions — no React hooks, no component state.
 * Each reads store state via `.getState()` and coordinates the
 * submit/cancel lifecycle for the contact-request interaction.
 */

import { t } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import {
  captureSubmissionRejection,
  reportSubmissionFailure,
} from "@/domains/chat/prompt-submission";
import { useStreamStore } from "@/domains/chat/stream-store";
import { useConversationStore } from "@/stores/conversation-store";
import { endTurn } from "@/domains/chat/turn-coordinator";
import { submitContactPrompt } from "@/domains/chat/api/interactions";

/**
 * Submit the contact address/channel to the daemon.
 * Optimistically dismisses the prompt after a 1.5 s delay (matching macOS).
 */
export async function handleContactPromptSubmit(
  address: string,
  channelType: string,
): Promise<void> {
  const { pendingContactRequest, submittingByKind } =
    useInteractionStore.getState();
  // Guards double-submitting this prompt, not any prompt; see
  // `prompt-submission.ts` for why that is not "anything in flight".
  if (
    !pendingContactRequest ||
    submittingByKind.contactRequest === pendingContactRequest.requestId
  ) {
    return;
  }
  useInteractionStore
    .getState()
    .claimSubmission("contactRequest", pendingContactRequest.requestId);
  useChatSessionStore.getState().setError(null);

  const ctx = useStreamStore.getState().streamContext;
  if (!ctx) {
    useChatSessionStore
      .getState()
      .setError({ message: t("chat:promptSubmission.noActiveSession") });
    useInteractionStore
      .getState()
      .releaseSubmission("contactRequest", pendingContactRequest.requestId);
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
      captureSubmissionRejection("submit_contact_prompt", result);
      reportSubmissionFailure(
        "contactRequest",
        pendingContactRequest.requestId,
        "contactActions.saveFailed",
      );
      useInteractionStore
        .getState()
        .releaseSubmission("contactRequest", pendingContactRequest.requestId);
      return;
    }

    useInteractionStore.getState().acceptContactRequest();
    useInteractionStore
      .getState()
      .releaseSubmission("contactRequest", pendingContactRequest.requestId);
    const savedRequestId = pendingContactRequest.requestId;
    setTimeout(() => {
      useInteractionStore
        .getState()
        .dismissContactRequestIfMatches(savedRequestId);
    }, 1500);
  } catch (err) {
    captureError(err, { context: "submit_contact_prompt" });
    reportSubmissionFailure(
      "contactRequest",
      pendingContactRequest.requestId,
      "contactActions.saveFailed",
    );
    useInteractionStore
      .getState()
      .releaseSubmission("contactRequest", pendingContactRequest.requestId);
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
