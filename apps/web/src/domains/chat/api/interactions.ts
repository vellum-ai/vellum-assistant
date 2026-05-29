/**
 * User interaction submission endpoints.
 *
 * Handles submitting responses to daemon-initiated prompts: secrets,
 * confirmations, contact lookups, user questions, and trust rules.
 */

import type { ConfirmationDecision } from "@/types/event-types";
import type { QuestionSubmission } from "@/domains/chat/api/event-types";
import {
  assertHasResponse,
  client,
  extractErrorMessage,
  SDK_BASE_OPTIONS,
} from "@/domains/chat/api/client";

export async function getPendingInteractions(
  assistantId: string,
  conversationId: string,
): Promise<{
  pendingConfirmation?: Record<string, unknown>;
  pendingSecret?: Record<string, unknown>;
}> {
  const { data, error, response } = await client.get<
    {
      pendingConfirmation?: Record<string, unknown>;
      pendingSecret?: Record<string, unknown>;
    },
    unknown
  >({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/pending-interactions/",
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
  const { data, error, response } = await client.get<unknown, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/pending-interactions/",
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
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return new Set();
  }
  const payload = data as { interactions?: unknown };
  const interactions = Array.isArray(payload.interactions)
    ? payload.interactions
    : [];
  const keys = new Set<string>();
  for (const i of interactions) {
    if (i && typeof i === "object") {
      const conversationId = (i as { conversationId?: unknown }).conversationId;
      if (typeof conversationId === "string" && conversationId) {
        keys.add(conversationId);
      }
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
    const { error, response } = await client.post<unknown, unknown>({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/secret/",
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

export async function submitConfirmation(
  assistantId: string,
  requestId: string,
  decision: ConfirmationDecision,
  trustRule?: { selectedPattern: string; selectedScope: string },
): Promise<SubmitSecretResponseResult> {
  try {
    const { error, response } = await client.post<unknown, unknown>({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/confirm/",
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
    const { error, response } = await client.post<unknown, unknown>({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/contacts/prompt/submit/",
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
  const body = (() => {
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
    const { error, response: httpResponse } = await client.post<
      unknown,
      unknown
    >({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/question-response/",
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

export async function submitTrustRule(
  assistantId: string,
  requestId: string,
  rule: Record<string, unknown>,
): Promise<SubmitSecretResponseResult> {
  try {
    const { error, response } = await client.post<unknown, unknown>({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/trust-rules/",
      path: { assistant_id: assistantId },
      body: { requestId, ...rule },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to submit trust rule");
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
