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
import {
  cancelContactPrompt,
  submitContactPrompt,
  submitContactRecord,
} from "@/domains/chat/api/interactions";

/**
 * Whether a rejected submission means the form itself is gone.
 *
 * The gateway answers 409 when the assistant has no such form pending: it
 * expired, or the assistant restarted after broadcasting it. That is terminal,
 * unlike a 503 from an assistant it could not reach, which is worth another
 * attempt.
 */
function isFormAlreadyClosed(result: { status?: number }): boolean {
  return result.status === 409;
}

/**
 * Whether the assistant's submit route predates dismissals.
 *
 * Asked of the response rather than the version, because the version cannot
 * answer it: the released 0.11.7 has no dismissal and a checkout of this
 * source reports the same 0.11.7, so no floor separates them. The route that
 * lacks the field rejects a body without an address, which one that has it
 * never does, so the 400 is the distinction itself. The request costs a round
 * trip and writes nothing.
 */
function isCancellationUnsupported(result: { status?: number }): boolean {
  return result.status === 400;
}

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

    const savedRequestId = pendingContactRequest.requestId;
    useInteractionStore
      .getState()
      .releaseSubmission("contactRequest", savedRequestId);

    if (result.duplicate) {
      // Another client answered this form first, so this address was not the
      // one written. Retire the card without claiming it saved anything.
      useInteractionStore
        .getState()
        .dismissContactRequestIfMatches(savedRequestId);
      return;
    }

    useInteractionStore
      .getState()
      .acceptContactRequestIfMatches(savedRequestId);
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
 * This form carries no conversation and outlives a conversation switch, so
 * the turn to end is the one that was on screen when it arrived, and only
 * while that is still where the guardian is. Ending whatever happens to be
 * active would error an unrelated turn that is still running.
 */
export async function handleContactPromptCancel(): Promise<void> {
  const request = useInteractionStore.getState().pendingContactRequest;
  if (!request) {
    return;
  }

  const ctx = useStreamStore.getState().streamContext;
  if (!ctx) {
    // Nothing was sent, so the command is still parked. Reporting this as a
    // dismissal would take away the only thing that could retry it.
    useChatSessionStore
      .getState()
      .setError({ message: t("chat:promptSubmission.noActiveSession") });
    return;
  }

  // Every client is showing this form and a command is parked on it, so the
  // dismissal has to reach the gateway: taking the card down here would leave
  // both waiting.
  const result = await cancelContactPrompt(ctx.assistantId, request.requestId);
  if (!result.ok) {
    if (isFormAlreadyClosed(result) || isCancellationUnsupported(result)) {
      // Either the assistant is no longer holding this form, or it never
      // understood the dismissal. Both are terminal, and both leave the card
      // permanent if it stays: every attempt gets the same answer. Taking it
      // down locally is what an assistant without dismissals has always done.
      useInteractionStore
        .getState()
        .dismissContactRequestIfMatches(request.requestId);
      return;
    }
    captureSubmissionRejection("cancel_contact_prompt", result);
    reportSubmissionFailure(
      "contactRequest",
      request.requestId,
      "contactActions.cancelFailed",
    );
    return;
  }

  useInteractionStore
    .getState()
    .dismissContactRequestIfMatches(request.requestId);
}

/**
 * Submit the guardian's answer to a proposed contact record write. The values
 * posted are the ones on the form, which the guardian may have edited.
 */
export async function handleContactRecordSubmit(values: {
  displayName?: string;
  notes?: string;
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
        ? {
            operation,
            contactId,
            // The channels this confirmation listed, so a contact that gained
            // one since is refused rather than cascaded away unseen.
            expectedChannels: pendingContactRecordRequest.channels,
          }
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

    const savedRequestId = pendingContactRecordRequest.requestId;
    useInteractionStore
      .getState()
      .releaseSubmission("contactRecordRequest", savedRequestId);

    if (result.duplicate) {
      // Another client answered this form first, so none of these values were
      // written. Retire the card without claiming it saved anything.
      useInteractionStore
        .getState()
        .dismissContactRecordRequestIfMatches(savedRequestId);
      return;
    }

    useInteractionStore
      .getState()
      .acceptContactRecordRequestIfMatches(savedRequestId);
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
  if (!ctx) {
    // Nothing was sent, so the command is still parked. Reporting this as a
    // dismissal would take away the only thing that could retry it.
    useChatSessionStore
      .getState()
      .setError({ message: t("chat:promptSubmission.noActiveSession") });
    return;
  }

  const result = await submitContactRecord(ctx.assistantId, request.requestId, {
    cancelled: true,
  });
  if (!result.ok) {
    if (isFormAlreadyClosed(result) || isCancellationUnsupported(result)) {
      // Nothing left to dismiss; see the address form's dismissal.
      useInteractionStore
        .getState()
        .dismissContactRecordRequestIfMatches(request.requestId);
      return;
    }
    captureSubmissionRejection("cancel_contact_record", result);
    reportSubmissionFailure(
      "contactRecordRequest",
      request.requestId,
      "contactActions.recordCancelFailed",
    );
    return;
  }

  useInteractionStore
    .getState()
    .dismissContactRecordRequestIfMatches(request.requestId);
}
