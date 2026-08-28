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
import {
  submitContactPrompt,
  submitContactRecord,
} from "@/domains/chat/api/interactions";

/**
 * Submit the contact address/channel to the daemon.
 * Optimistically dismisses the prompt after a 1.5 s delay (matching macOS).
 */
export async function handleContactPromptSubmit(
  address: string,
  channelType: string,
  verify: boolean,
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
      undefined,
      verify,
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
 * Cancel the contact prompt: dismisses local state and ends the turn it
 * belongs to.
 *
 * This form carries no conversation, and it now outlives a conversation
 * switch, so the turn to end is the one that was on screen when it arrived
 * and only while that is still where the guardian is. Ending whatever happens
 * to be active would error an unrelated turn that is still running.
 */
export function handleContactPromptCancel(): void {
  const request = useInteractionStore.getState().pendingContactRequest;
  if (request) {
    useInteractionStore
      .getState()
      .dismissContactRequestIfMatches(request.requestId);
  }
  const activeConversationId =
    useConversationStore.getState().activeConversationId;
  if (
    request?.originConversationId &&
    request.originConversationId === activeConversationId
  ) {
    endTurn({ conversationId: activeConversationId, reason: "error" });
  }
}

/**
 * Submit the guardian's answer to a proposed contact record write. The values
 * posted are the ones on the form, which the guardian may have edited.
 */
export async function handleContactRecordSubmit(values: {
  displayName: string;
  notes: string;
}): Promise<void> {
  const { pendingContactRecordRequest, submittingByKind } =
    useInteractionStore.getState();
  if (
    !pendingContactRecordRequest ||
    submittingByKind.contactRecordRequest ===
      pendingContactRecordRequest.requestId
  ) {
    return;
  }
  useInteractionStore
    .getState()
    .claimSubmission(
      "contactRecordRequest",
      pendingContactRecordRequest.requestId,
    );
  useChatSessionStore.getState().setError(null);

  const ctx = useStreamStore.getState().streamContext;
  if (!ctx) {
    useChatSessionStore
      .getState()
      .setError({ message: t("chat:promptSubmission.noActiveSession") });
    useInteractionStore
      .getState()
      .releaseSubmission(
        "contactRecordRequest",
        pendingContactRecordRequest.requestId,
      );
    return;
  }

  const { operation, contactId } = pendingContactRecordRequest;

  try {
    const result = await submitContactRecord(
      ctx.assistantId,
      pendingContactRecordRequest.requestId,
      operation === "delete"
        ? { operation, contactId }
        : {
            operation,
            contactId,
            displayName: values.displayName,
            notes: values.notes,
          },
    );
    if (!result.ok) {
      captureSubmissionRejection("submit_contact_record", result);
      reportSubmissionFailure(
        "contactRecordRequest",
        pendingContactRecordRequest.requestId,
        "contactActions.recordSaveFailed",
      );
      useInteractionStore
        .getState()
        .releaseSubmission(
          "contactRecordRequest",
          pendingContactRecordRequest.requestId,
        );
      return;
    }

    useInteractionStore.getState().acceptContactRecordRequest();
    useInteractionStore
      .getState()
      .releaseSubmission(
        "contactRecordRequest",
        pendingContactRecordRequest.requestId,
      );
    const savedRequestId = pendingContactRecordRequest.requestId;
    setTimeout(() => {
      useInteractionStore
        .getState()
        .dismissContactRecordRequestIfMatches(savedRequestId);
    }, 1500);
  } catch (err) {
    captureError(err, { context: "submit_contact_record" });
    reportSubmissionFailure(
      "contactRecordRequest",
      pendingContactRecordRequest.requestId,
      "contactActions.recordSaveFailed",
    );
    useInteractionStore
      .getState()
      .releaseSubmission(
        "contactRecordRequest",
        pendingContactRecordRequest.requestId,
      );
  }
}

/**
 * Dismiss a proposed contact record write. Tells the gateway so the parked
 * command returns now instead of waiting out its timeout on a form nobody is
 * going to answer.
 *
 * The card stays until the dismissal is accepted. Taking it down first would
 * leave a failed cancel with nothing to retry from, and the command parked
 * anyway.
 */
export async function handleContactRecordCancel(): Promise<void> {
  const request = useInteractionStore.getState().pendingContactRecordRequest;
  if (!request) {
    return;
  }

  const ctx = useStreamStore.getState().streamContext;
  if (ctx) {
    const result = await submitContactRecord(
      ctx.assistantId,
      request.requestId,
      { cancelled: true },
    );
    if (!result.ok) {
      captureSubmissionRejection("cancel_contact_record", result);
      reportSubmissionFailure(
        "contactRecordRequest",
        request.requestId,
        "contactActions.recordCancelFailed",
      );
      return;
    }
  }

  useInteractionStore
    .getState()
    .dismissContactRecordRequestIfMatches(request.requestId);

  // This form carries no conversation, so the only turn a dismissal may end is
  // the one that was on screen when it arrived, and only while that is still
  // where the guardian is. Ending whatever happens to be active would error an
  // unrelated turn that is still running.
  const activeConversationId =
    useConversationStore.getState().activeConversationId;
  if (
    request.originConversationId &&
    request.originConversationId === activeConversationId
  ) {
    endTurn({ conversationId: activeConversationId, reason: "error" });
  }
}
