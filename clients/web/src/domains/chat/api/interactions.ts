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
import { assistantContactsPromptSubmit } from "@/generated/gateway/sdk.gen";
import type {
  PendinginteractionsGetResponse,
  QuestionresponsePostData,
} from "@/generated/daemon/types.gen";
import { assertHasResponse, extractErrorMessage } from "@/utils/api-errors";

/**
 * Subset of the pending-interactions response returned for a single
 * conversation. The full response also carries the cross-conversation
 * `interactions` list, which only the bulk reader below consumes.
 */
type ConversationPendingInteractions = Pick<
  PendinginteractionsGetResponse,
  "pendingConfirmation" | "pendingSecret"
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

export type SubmitSecretResponseResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

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
      return { ok: false, status: response.status, error: msg };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : "Something went wrong.",
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
      return { ok: false, status: response.status, error: msg };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : "Something went wrong.",
    };
  }
}

export async function submitConfirmation(
  assistantId: string,
  requestId: string,
  decision: ConfirmationDecision,
  trustRule?: { selectedPattern: string; selectedScope: string },
): Promise<SubmitSecretResponseResult> {
  try {
    const { error, response } = await confirmPost({
      path: { assistant_id: assistantId },
      body: { requestId, decision, ...trustRule },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to submit confirmation");
    if (!response.ok) {
      const msg = extractErrorMessage(error, response);
      return { ok: false, status: response.status, error: msg };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : "Something went wrong.",
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
): Promise<SubmitSecretResponseResult> {
  try {
    const { error, response } = await assistantContactsPromptSubmit({
      path: { assistant_id: assistantId },
      body: { requestId, address, channelType, role, displayName },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to submit contact prompt");
    if (!response.ok) {
      const msg = extractErrorMessage(error, response);
      return { ok: false, status: response.status, error: msg };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : "Something went wrong.",
    };
  }
}

/**
 * Submit a response to a `question_request` event emitted by the daemon's
 * `ask_user_question` tool. Fire-and-forget, mirroring `submitConfirmation`:
 * the daemon resolves the awaiting tool call on its side and pushes any
 * follow-up state changes back through SSE. Body discriminator is `kind`:
 *  - `{ kind: "option", optionId }` — user picked one of the daemon-supplied options.
 *  - `{ kind: "free_text", text }` — user typed a manual answer.
 */
export async function submitQuestionResponse(
  assistantId: string,
  requestId: string,
  submission: QuestionSubmission,
): Promise<SubmitSecretResponseResult> {
  // For single-entry submissions, prefer the legacy `{ kind: "option" | "free_text" }`
  // wire shape — older daemons predate the batched `{ kind: "submit", responses }`
  // contract, and rolling deploys can leave the daemon side behind the web side.
  // Both legacy and new daemons accept the legacy shape; only newer daemons accept
  // the batched shape, so reserve it for multi-entry submissions where it's
  // strictly required. `skip` is not a legacy top-level kind, so we coerce it
  // to an empty `free_text` so the daemon resolves the interaction instead of
  // hanging on a malformed payload.
  const body: QuestionresponsePostData["body"] = (() => {
    if (submission.kind === "close") {
      return { requestId, kind: "close" };
    }
    if (submission.responses.length !== 1) {
      return { requestId, kind: "submit", responses: submission.responses };
    }
    const only = submission.responses[0];
    if (!only) {
      return { requestId, kind: "submit", responses: submission.responses };
    }
    if (only.kind === "option") {
      return { requestId, kind: "option", optionId: only.optionId };
    }
    if (only.kind === "free_text") {
      return { requestId, kind: "free_text", text: only.text };
    }
    return { requestId, kind: "free_text", text: "" };
  })();
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
      return { ok: false, status: httpResponse.status, error: msg };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : "Something went wrong.",
    };
  }
}

