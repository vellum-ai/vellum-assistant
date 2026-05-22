// Paginated history fetchers for assistant runtime messages.
//
// The legacy `./api.ts` module carries an explicit "DO NOT ADD ONTO THIS FILE"
// banner at its top, so all new history-related fetchers live here in a
// focused module. These fetchers back the virtualized/windowed transcript:
// the UI loads the most recent page on open and pages older history in on
// demand as the user scrolls up.

// Side-effect import — configures the HeyAPI client (CSRF cookie + active
// organization header) exactly the same way `./api.ts` does.

import { client } from "@/generated/api/client.gen.js";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/lib/api-errors.js";
import {
  recordChatDiagnostic,
  summarizeDisplayMessages,
} from "@/domains/chat/utils/diagnostics.js";

import { mapRuntimeToDisplayMessage } from "@/domains/chat/utils/map-runtime-message.js";
import { dedupeDisplayMessages } from "@/domains/chat/utils/reconcile.js";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types.js";
import type {
  RuntimeMessage,
  RuntimeSubagentNotification,
} from "@/domains/chat/api/messages.js";

const SDK_BASE_OPTIONS =
  typeof window === "undefined"
    ? ({ baseUrl: "http://localhost" } as const)
    : ({} as const);

export type { PaginatedHistoryResult };

const DEFAULT_LATEST_LIMIT = 50;
const DEFAULT_OLDER_LIMIT = 50;

interface PaginatedHistoryResponseBody {
  messages?: unknown;
  hasMore?: unknown;
  oldestTimestamp?: unknown;
  oldestMessageId?: unknown;
}

function parsePaginatedResponse(
  body: PaginatedHistoryResponseBody,
): PaginatedHistoryResult {
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const validMessages = rawMessages.filter(
    (m): m is RuntimeMessage =>
      !!m &&
      typeof m === "object" &&
      ((m as RuntimeMessage).role === "user" ||
        (m as RuntimeMessage).role === "assistant"),
  );

  // Map to display messages first so we can correlate stableIds with
  // subagent notifications. The two arrays share the same indices.
  const mapped = validMessages.map(mapRuntimeToDisplayMessage);
  const messages = dedupeDisplayMessages(mapped);

  // Extract notifications and associate each with the stableId of the
  // last non-notification assistant message (the message that spawned
  // the subagent). This mirrors macOS HistoryReconstructionService.
  const subagentNotifications: RuntimeSubagentNotification[] = [];
  let lastAssistantMessageId: string | undefined;
  for (let i = 0; i < validMessages.length; i++) {
    const m = validMessages[i];
    if (!m) continue;
    if (m.role === "assistant" && !m.subagentNotification) {
      lastAssistantMessageId = m.id;
    }
    const n = m.subagentNotification;
    if (n && typeof n === "object" && typeof n.subagentId === "string") {
      subagentNotifications.push({
        ...n,
        parentMessageId: lastAssistantMessageId,
      });
    }
  }

  const hasMore = typeof body.hasMore === "boolean" ? body.hasMore : false;
  const oldestTimestamp =
    typeof body.oldestTimestamp === "number" &&
    Number.isFinite(body.oldestTimestamp)
      ? body.oldestTimestamp
      : null;
  const oldestMessageId =
    typeof body.oldestMessageId === "string" && body.oldestMessageId.length > 0
      ? body.oldestMessageId
      : null;

  return {
    messages,
    hasMore,
    oldestTimestamp,
    oldestMessageId,
    ...(subagentNotifications.length > 0 ? { subagentNotifications } : {}),
  };
}

async function fetchPaginatedHistory(
  assistantId: string,
  query: Record<string, string>,
): Promise<PaginatedHistoryResult> {
  const { data, error, response } = await client.get<
    PaginatedHistoryResponseBody,
    unknown
  >({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/messages/",
    path: { assistant_id: assistantId },
    query,
    throwOnError: false,
  });

  assertHasResponse(response, error, "Failed to fetch history");
  if (!response.ok) {
    recordChatDiagnostic("history_page_fetch_error", {
      assistantId,
      query,
      status: response.status,
    });
    const message = extractErrorMessage(
      error,
      response,
      `Failed to fetch history (HTTP ${response.status})`,
    );
    throw new ApiError(response.status, message);
  }

  const result = parsePaginatedResponse(data ?? {});
  recordChatDiagnostic("history_page_fetch", {
    assistantId,
    query,
    status: response.status,
    hasMore: result.hasMore,
    oldestTimestamp: result.oldestTimestamp,
    oldestMessageId: result.oldestMessageId,
    messages: summarizeDisplayMessages(result.messages),
  });
  return result;
}

/**
 * Fetch the newest page of history for a conversation. Corresponds to the
 * runtime's `page=latest` sentinel — the server returns the most recent
 * `limit` messages in chronological (oldest-first) order along with a
 * `hasMore` flag that reflects whether older messages exist.
 */
export async function fetchLatestHistoryPage(
  assistantId: string,
  conversationKey: string,
  limit: number = DEFAULT_LATEST_LIMIT,
): Promise<PaginatedHistoryResult> {
  return fetchPaginatedHistory(assistantId, {
    conversationId: conversationKey,
    conversationKey,
    page: "latest",
    limit: String(limit),
  });
}

/**
 * Fetch a page of history older than `beforeTimestamp`. Used by the
 * transcript's infinite-scroll-up handler: the UI passes the
 * `oldestTimestamp` from the currently loaded window and receives the next
 * older `limit` messages.
 */
export async function fetchOlderHistoryPage(
  assistantId: string,
  conversationKey: string,
  beforeTimestamp: number,
  limit: number = DEFAULT_OLDER_LIMIT,
): Promise<PaginatedHistoryResult> {
  return fetchPaginatedHistory(assistantId, {
    conversationId: conversationKey,
    conversationKey,
    beforeTimestamp: String(beforeTimestamp),
    limit: String(limit),
  });
}
