import { queryOptions, useQuery } from "@tanstack/react-query";

import {
  conversationsLlmcontextGet,
  messagesByIdLlmcontextGet,
} from "@/generated/daemon/sdk.gen";
import { assertHasResponse, extractErrorMessage } from "@/utils/api-errors";
import { fetchConversationMessages } from "@/domains/chat/api/messages";
import { supportsLlmContextSummaryView } from "@/lib/backwards-compat/llm-context-summary-view";

import type {
  ConversationMessage,
  LlmContextResponse,
  LLMRequestLogEntry,
  MemoryRecallLog,
  MemoryV2ActivationLog,
} from "@vellumai/assistant-api";

/**
 * Query helpers for the inspector. Two fetch modes:
 *
 * - **Conversation mode** (`messageId` omitted) — calls
 *   `GET /v1/conversations/llm-context`, reachable via the platform's
 *   `RuntimeProxyWildcardView` at
 *   `/v1/assistants/{assistantId}/conversations/llm-context/`. On
 *   daemons that predate the conversation-scoped endpoint, the client
 *   transparently falls back to fanning out per-message fetches.
 *
 * - **Message mode** (`messageId` provided) — calls
 *   `GET /v1/messages/{messageId}/llm-context`, reachable at
 *   `/v1/assistants/{assistantId}/messages/{messageId}/llm-context/`.
 *   The page enters this mode when the URL carries `?messageId=…` —
 *   either from the per-message "Inspect this message" hover action,
 *   or from the in-page "filter to this message" control.
 *
 * On assistants supporting it (see `lib/backwards-compat/
 * llm-context-summary-view.ts`), both modes request `view=summary`,
 * which omits the heavy per-log request/response sections. The
 * selected call's sections are then fetched lazily via
 * `useLlmCallDetail` (`inspector-detail-api.ts`). Older assistants
 * keep receiving the full list, which downstream consumers treat as
 * already-loaded detail.
 */

function summaryViewQuery(): { view?: "summary" } {
  return supportsLlmContextSummaryView() ? { view: "summary" } : {};
}

export class LlmContextRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "LlmContextRequestError";
    this.status = status;
  }
}

export function llmContextQueryOptions(
  assistantId: string | undefined,
  conversationId: string | undefined,
  messageId: string | null | undefined,
) {
  const normalizedMessageId = messageId || undefined;
  const enabled = Boolean(
    assistantId && (normalizedMessageId || conversationId),
  );
  return queryOptions({
    queryKey: [
      "assistants",
      assistantId,
      "llm-context",
      normalizedMessageId
        ? { scope: "message", messageId: normalizedMessageId }
        : { scope: "conversation", conversationId },
    ] as const,
    queryFn: async ({ signal }): Promise<LlmContextResponse> => {
      if (!assistantId) {
        throw new LlmContextRequestError(0, "Missing assistantId");
      }
      if (normalizedMessageId) {
        return await fetchMessageLlmContextOrThrow(
          assistantId,
          normalizedMessageId,
          signal,
        );
      }
      if (!conversationId) {
        throw new LlmContextRequestError(0, "Missing conversationId");
      }
      return await fetchConversationLlmContext(
        assistantId,
        conversationId,
        signal,
      );
    },
    enabled,
    staleTime: 30_000,
  });
}

export function useLlmContext(
  assistantId: string | undefined,
  conversationId: string | undefined,
  messageId?: string | null,
) {
  return useQuery(
    llmContextQueryOptions(assistantId, conversationId, messageId),
  );
}

/**
 * Best-effort fetch of the conversation's full log list, used in
 * message-scoped mode to map each scoped call back to its position in
 * the whole conversation ("Call 12" instead of renumbering from 1).
 *
 * Deliberately hits ONLY `GET /v1/conversations/llm-context` — no
 * legacy per-message fan-out. On daemons that predate that endpoint
 * (or on any failure) it resolves to `null` and the UI falls back to
 * subset-relative numbering, rather than issuing one request per
 * message just to compute labels.
 */
export function useConversationCallNumbering(
  assistantId: string | undefined,
  conversationId: string | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [
      "assistants",
      assistantId,
      "llm-context-call-numbering",
      conversationId,
    ] as const,
    queryFn: async ({
      signal,
    }): Promise<LLMRequestLogEntry[] | null> => {
      if (!assistantId || !conversationId) return null;
      const { data, response } = await conversationsLlmcontextGet({
        path: { assistant_id: assistantId },
        query: { conversationId, ...summaryViewQuery() },
        signal,
        throwOnError: false,
      });
      if (!response || !response.ok || !data) return null;
      return data.logs ?? [];
    },
    enabled: Boolean(enabled && assistantId && conversationId),
    staleTime: 30_000,
  });
}

/**
 * Lightweight query used by the "filter to message" dropdown in
 * conversation mode. Returns the conversation's message list so the
 * UI can render a labelled scope selector.
 *
 * Cached by `(assistantId, conversationId)` and short-stale (30s) —
 * the dropdown is rendered alongside the inspector logs and a fresh
 * fetch on every keystroke would be wasteful.
 */
export function useConversationMessageList(
  assistantId: string | undefined,
  conversationId: string | undefined,
) {
  const enabled = Boolean(assistantId && conversationId);
  return useQuery({
    queryKey: [
      "assistants",
      assistantId,
      "conversations",
      conversationId,
      "messages",
      "for-inspector",
    ] as const,
    queryFn: async (): Promise<ConversationMessage[]> => {
      if (!assistantId || !conversationId) return [];
      const snapshot = await fetchConversationMessages(
        assistantId,
        conversationId,
      );
      return snapshot?.messages ?? [];
    },
    enabled,
    staleTime: 30_000,
  });
}

/**
 * Try the conversation-scoped endpoint first. If the daemon doesn't
 * know that route (404), fall back to the per-message endpoint for
 * every message in the conversation. Exported for testing.
 */
export async function fetchConversationLlmContext(
  assistantId: string,
  conversationId: string,
  signal: AbortSignal | undefined,
): Promise<LlmContextResponse> {
  // The `{ 200: T }` shape is the documented HeyAPI pattern for
  // declaring a response type by status code. Passing a flat object as
  // the generic happens to work for *interfaces* (which don't satisfy
  // HeyAPI's `Record<string, unknown>` branch), but `z.infer`-derived
  // type aliases trip that branch and `data` collapses to the union of
  // property value types. Status-keyed form avoids the quirk and is
  // strictly more correct.
  const { data, error, response } = await conversationsLlmcontextGet({
    path: { assistant_id: assistantId },
    query: { conversationId, ...summaryViewQuery() },
    signal,
    throwOnError: false,
  });

  assertHasResponse(response, error, "Failed to fetch LLM context");

  if (response.status === 404) {
    return await fetchConversationLlmContextFromPerMessage(
      assistantId,
      conversationId,
      signal,
    );
  }

  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to load LLM context",
    );
    throw new LlmContextRequestError(response.status, msg);
  }

  if (!data) {
    throw new LlmContextRequestError(
      response.status,
      "Empty response from LLM context endpoint",
    );
  }

  return data;
}

/**
 * Fetch the LLM context for a single message. Throws if the request
 * fails — the page renders an error state instead of falling back,
 * since there's no meaningful "all messages" fallback when the user
 * explicitly scoped to one message. Exported for testing.
 */
export async function fetchMessageLlmContextOrThrow(
  assistantId: string,
  messageId: string,
  signal: AbortSignal | undefined,
): Promise<LlmContextResponse> {
  const { data, error, response } = await messagesByIdLlmcontextGet({
    path: { assistant_id: assistantId, id: messageId },
    query: summaryViewQuery(),
    signal,
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to fetch message LLM context");
  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to load LLM context",
    );
    throw new LlmContextRequestError(response.status, msg);
  }
  if (!data) {
    throw new LlmContextRequestError(
      response.status,
      "Empty response from message LLM context endpoint",
    );
  }
  return data;
}

/**
 * Legacy fallback. Fetches every message in the conversation, calls
 * the per-message LLM context endpoint for each, and merges the logs
 * (de-duplicated by log id, ordered chronologically). Used when the
 * daemon predates `GET /v1/conversations/llm-context`.
 *
 * Each per-message call returns the entire turn that contains the
 * message, so adjacent messages frequently return overlapping log
 * sets — the dedup pass collapses them. Memory recall / v2 activation
 * are turn-scoped, so we keep the most recent non-null one observed.
 */
async function fetchConversationLlmContextFromPerMessage(
  assistantId: string,
  conversationId: string,
  signal: AbortSignal | undefined,
): Promise<LlmContextResponse> {
  const snapshot = await fetchConversationMessages(
    assistantId,
    conversationId,
  );
  const messages = snapshot?.messages ?? [];

  const messageIds: string[] = [];
  const seenMessageId = new Set<string>();
  for (const m of messages) {
    const id = m.id;
    if (!id || seenMessageId.has(id)) continue;
    seenMessageId.add(id);
    messageIds.push(id);
  }

  if (messageIds.length === 0) {
    return {
      conversationId,
      conversationKind: "user",
      conversationTotalEstimatedCostUsd: null,
      logs: [],
      memoryRecall: null,
      memoryV2Activation: null,
    };
  }

  const perMessage = await Promise.all(
    messageIds.map((messageId) =>
      fetchMessageLlmContextTolerant(assistantId, messageId, signal),
    ),
  );

  let conversationKind = "user";
  let conversationTotalEstimatedCostUsd: number | null = null;
  let memoryRecall: MemoryRecallLog | null = null;
  let memoryV2Activation: MemoryV2ActivationLog | null = null;

  const seenLogId = new Set<string>();
  const allLogs: LLMRequestLogEntry[] = [];

  for (const r of perMessage) {
    if (!r) continue;
    if (r.conversationKind) conversationKind = r.conversationKind;
    if (r.conversationTotalEstimatedCostUsd != null) {
      conversationTotalEstimatedCostUsd = r.conversationTotalEstimatedCostUsd;
    }
    if (r.memoryRecall) memoryRecall = r.memoryRecall;
    if (r.memoryV2Activation) memoryV2Activation = r.memoryV2Activation;
    for (const log of r.logs ?? []) {
      if (seenLogId.has(log.id)) continue;
      seenLogId.add(log.id);
      allLogs.push(log);
    }
  }

  allLogs.sort((a, b) => a.createdAt - b.createdAt);

  return {
    conversationId,
    conversationKind,
    conversationTotalEstimatedCostUsd,
    logs: allLogs,
    memoryRecall,
    memoryV2Activation,
  };
}

/**
 * Single per-message fetch used by the legacy fallback. Tolerant of
 * missing data and per-call 404s — those just contribute zero logs.
 */
async function fetchMessageLlmContextTolerant(
  assistantId: string,
  messageId: string,
  signal: AbortSignal | undefined,
): Promise<LlmContextResponse | null> {
  const { data, response } = await messagesByIdLlmcontextGet({
    path: { assistant_id: assistantId, id: messageId },
    signal,
    throwOnError: false,
  });
  if (!response || !response.ok || !data) return null;
  return data;
}
