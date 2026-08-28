/**
 * User interaction submission endpoints.
 *
 * Handles submitting responses to daemon-initiated prompts: secrets,
 * confirmations, contact lookups, user questions, and trust rules.
 */

import type { ConfirmationDecision } from "@/types/event-types";
import type { QuestionSubmission } from "@/domains/chat/api/event-types";
import {
  confirmPost,
  pendinginteractionsGet,
  questionresponsePost,
  secretPost,
} from "@/generated/daemon/sdk.gen";
import {
  assistantContactsPromptSubmit,
  assistantContactsRecordSubmit,
} from "@/generated/gateway/sdk.gen";
import type {
  PendinginteractionsGetResponse,
  QuestionresponsePostData,
} from "@/generated/daemon/types.gen";
import { resolveSupportsBatchedQuestionSubmit } from "@/lib/backwards-compat/batched-question-submit";
import { assertHasResponse, extractErrorMessage } from "@/utils/api-errors";
import { isTransientNetworkError } from "@/utils/is-transient-network-error";

/**
 * Subset of the pending-interactions response returned for a single
 * conversation. The full response also carries the cross-conversation
 * `interactions` list, which only the bulk reader below consumes.
 *
 * `pendingQuestion` is three-valued and every value is load-bearing: an object
 * is the outstanding prompt, `null` is the registry positively reporting none,
 * and `undefined` means the assistant predates the field and cannot answer the
 * question at all. Only the first two authorize the caller to raise or retire
 * a card; see `applyReportedQuestion` in `use-conversation-history`.
 */
export type ConversationPendingInteractions = Pick<
  PendinginteractionsGetResponse,
  "pendingConfirmation" | "pendingSecret" | "pendingQuestion"
>;

export async function getPendingInteractions(
  assistantId: string,
  conversationId: string,
): Promise<ConversationPendingInteractions> {
  const { data, error, response } = await pendinginteractionsGet({
    path: { assistant_id: assistantId },
    query: { conversationId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to fetch pending interactions");
  if (!response.ok) {
    if (response.status >= 500) {
      throw new Error(`getPendingInteractions failed: ${response.status}`);
    }
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {};
  }
  return data;
}

/**
 * Bulk-fetch every pending interaction the daemon currently knows about,
 * across every conversation.
 *
 * Used by attention-tracking effects so we don't fan out one request per
 * conversation on mount / poll. The returned set contains every conversation
 * key that has at least one pending interaction; callers reconcile against
 * their own state. Conversation key equals conversation id in the web client.
 */
export async function listConversationIdsWithPendingInteractions(
  assistantId: string,
): Promise<Set<string>> {
  const { data, error, response } = await pendinginteractionsGet({
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to list pending interactions");
  if (!response.ok) {
    if (response.status >= 500) {
      throw new Error(
        `listConversationIdsWithPendingInteractions failed: ${response.status}`,
      );
    }
    return new Set();
  }
  const keys = new Set<string>();
  for (const interaction of data?.interactions ?? []) {
    if (interaction.conversationId) {
      keys.add(interaction.conversationId);
    }
  }
  return keys;
}

/**
 * `transient` marks a failure the transport produced rather than the assistant:
 * offline, a dropped connection, an interrupted fetch. The helpers below catch
 * those and flatten them into an ordinary `ok: false`, which loses the original
 * `TypeError` that `isTransientNetworkError` keys on, so the answer is recorded
 * here while that object still exists. Callers use it to skip the error report
 * a connectivity blip does not deserve.
 */
export type SubmitSecretResponseResult =
  | { ok: true }
  | { ok: false; status: number; error: string; transient: boolean };

export async function submitSecretResponse(
  assistantId: string,
  requestId: string,
  value: string,
  delivery: string = "store",
): Promise<SubmitSecretResponseResult> {
  try {
    const { error, response } = await secretPost({
      path: { assistant_id: assistantId },
      body: { requestId, value, delivery },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to submit secret response");
    if (!response.ok) {
      const msg = extractErrorMessage(error, response);
      return {
        ok: false,
        status: response.status,
        error: msg,
        transient: false,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : "Something went wrong.",
      transient: isTransientNetworkError(err),
    };
  }
}

/**
 * Dismiss an address form. Unblocks the parked command without writing, and
 * closes the form on every other client showing it.
 */
export async function cancelContactPrompt(
  assistantId: string,
  requestId: string,
): Promise<SubmitSecretResponseResult & { duplicate?: boolean }> {
  try {
    const { data, error, response } = await assistantContactsPromptSubmit({
      path: { assistant_id: assistantId },
      body: { requestId, cancelled: true },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to dismiss the contact prompt");
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: extractErrorMessage(error, response),
        transient: false,
      };
    }
    // Somebody answered the form before this dismissal reached it, so the
    // dismissal did not decide anything.
    return { ok: true, duplicate: data?.duplicate === true };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : "Something went wrong.",
      transient: isTransientNetworkError(err),
    };
  }
}

/**
 * Submit the guardian's answer to a proposed contact record write, or their
 * dismissal of it. The gateway performs the write and unblocks the parked
 * command; a dismissal unblocks it without writing.
 */
export async function submitContactRecord(
  assistantId: string,
  requestId: string,
  input:
    | {
        operation: "create" | "update" | "delete";
        contactId?: string;
        displayName?: string;
        notes?: string;
        expectedChannels?: Array<{ type: string; address: string }>;
      }
    | { cancelled: true },
): Promise<SubmitSecretResponseResult & { duplicate?: boolean }> {
  try {
    const { data, error, response } = await assistantContactsRecordSubmit({
      path: { assistant_id: assistantId },
      body: { requestId, ...input },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to submit contact record");
    if (!response.ok) {
      const msg = extractErrorMessage(error, response);
      return {
        ok: false,
        status: response.status,
        error: msg,
        transient: false,
      };
    }
    // Somebody else answered this form first. The request succeeded in the
    // sense that nothing is wrong, but none of these values were written, so
    // the caller must not present them as saved.
    return { ok: true, duplicate: data?.duplicate === true };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : "Something went wrong.",
      transient: isTransientNetworkError(err),
    };
  }
}

/**
 * Cancel a pending secret prompt. Posts ONLY `{ requestId }` (no `value`,
 * no `delivery`) so the daemon resolves the awaiting interaction as cancelled
 * — the daemon treats an absent `value` as cancellation.
 */
export async function submitSecretCancel(
  assistantId: string,
  requestId: string,
): Promise<SubmitSecretResponseResult> {
  try {
    const { error, response } = await secretPost({
      path: { assistant_id: assistantId },
      body: { requestId },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to cancel secret prompt");
    if (!response.ok) {
      const msg = extractErrorMessage(error, response);
      return {
        ok: false,
        status: response.status,
        error: msg,
        transient: false,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : "Something went wrong.",
      transient: isTransientNetworkError(err),
    };
  }
}

export async function submitConfirmation(
  assistantId: string,
  requestId: string,
  decision: ConfirmationDecision,
): Promise<SubmitSecretResponseResult> {
  try {
    const { error, response } = await confirmPost({
      path: { assistant_id: assistantId },
      body: { requestId, decision },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to submit confirmation");
    if (!response.ok) {
      const msg = extractErrorMessage(error, response);
      return {
        ok: false,
        status: response.status,
        error: msg,
        transient: false,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : "Something went wrong.",
      transient: isTransientNetworkError(err),
    };
  }
}

export async function submitContactPrompt(
  assistantId: string,
  requestId: string,
  address: string,
  channelType: string,
  role?: string,
  displayName?: string,
  /**
   * The verify checkbox as the guardian left it. Sent explicitly (rather than
   * read back from the parked command) so the attest matches the form.
   */
  verify?: boolean,
): Promise<SubmitSecretResponseResult & { duplicate?: boolean }> {
  try {
    const { data, error, response } = await assistantContactsPromptSubmit({
      path: { assistant_id: assistantId },
      body: { requestId, address, channelType, role, displayName, verify },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to submit contact prompt");
    if (!response.ok) {
      const msg = extractErrorMessage(error, response);
      return {
        ok: false,
        status: response.status,
        error: msg,
        transient: false,
      };
    }
    // Somebody else answered this form first: nothing is wrong, but none of
    // these values were written, so the caller must not present them as saved.
    return { ok: true, duplicate: data?.duplicate === true };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : "Something went wrong.",
      transient: isTransientNetworkError(err),
    };
  }
}

/**
 * Pick the wire shape for an answer and build the body.
 *
 * Only a one-entry answer has a choice to make, so only that case waits on the
 * version. A close and a multi-entry answer are posted the same way to every
 * assistant, and making them wait would stall a dismissal behind an identity
 * fetch that cannot change what is sent.
 */
async function buildQuestionResponseBody(
  assistantId: string,
  requestId: string,
  submission: QuestionSubmission,
): Promise<QuestionresponsePostData["body"]> {
  if (submission.kind === "close") {
    return { requestId, kind: "close" };
  }
  const batched = {
    requestId,
    kind: "submit",
    responses: submission.responses,
  } as const;
  const only =
    submission.responses.length === 1 ? submission.responses[0] : undefined;
  if (!only || (await resolveSupportsBatchedQuestionSubmit(assistantId))) {
    return batched;
  }
  if (only.kind === "option") {
    return { requestId, kind: "option", optionId: only.optionId };
  }
  if (only.kind === "free_text") {
    return { requestId, kind: "free_text", text: only.text };
  }
  // The legacy shape has no `skip`, and an assistant that only speaks it would
  // reject an unparseable body. Blank free text is the closest thing it can
  // express, and `answered-question.ts` reads one back as a skip.
  return { requestId, kind: "free_text", text: "" };
}

/**
 * Submit a response to a `question_request` event emitted by the daemon's
 * `ask_user_question` tool. Fire-and-forget, mirroring `submitConfirmation`:
 * the daemon resolves the awaiting tool call on its side and pushes any
 * follow-up state changes back through SSE.
 *
 * The body is the batched `{ kind: "submit", responses }` shape, or
 * `{ kind: "close" }` for a dismissal. Assistants older than the batched
 * contract get the legacy single-question shape for a one-entry submission;
 * see `lib/backwards-compat/batched-question-submit.ts` for what that costs.
 */
export async function submitQuestionResponse(
  assistantId: string,
  requestId: string,
  submission: QuestionSubmission,
): Promise<SubmitSecretResponseResult> {
  const body = await buildQuestionResponseBody(
    assistantId,
    requestId,
    submission,
  );
  try {
    const { error, response: httpResponse } = await questionresponsePost({
      path: { assistant_id: assistantId },
      body,
      throwOnError: false,
    });
    assertHasResponse(
      httpResponse,
      error,
      "Failed to submit question response",
    );
    if (!httpResponse.ok) {
      const msg = extractErrorMessage(error, httpResponse);
      return {
        ok: false,
        status: httpResponse.status,
        error: msg,
        transient: false,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : "Something went wrong.",
      transient: isTransientNetworkError(err),
    };
  }
}
