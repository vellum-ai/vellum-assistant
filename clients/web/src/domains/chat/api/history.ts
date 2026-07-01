// Paginated history fetchers for assistant runtime messages.
//
// The legacy `./api.ts` module carries an explicit "DO NOT ADD ONTO THIS FILE"
// banner at its top, so all new history-related fetchers live here in a
// focused module. These fetchers back the virtualized/windowed transcript:
// the UI loads the most recent page on open and pages older history in on
// demand as the user scrolls up.

import { messagesGet } from "@/generated/daemon/sdk.gen";
import type {
  MessagesGetData,
  MessagesGetResponse,
} from "@/generated/daemon/types.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";
import { recordDiagnostic } from "@/lib/diagnostics";
import { summarizeDisplayMessages } from "@/domains/chat/utils/diagnostics";

import { mapRuntimeToDisplayMessage } from "@/domains/chat/utils/map-runtime-message";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";
import {
  toBackgroundTaskEntryFromCompletion,
  type RuntimeSubagentNotification,
} from "@/domains/chat/api/messages";
import type { BackgroundTaskEntry } from "@/domains/chat/background-task-store";

export type { PaginatedHistoryResult };

const DEFAULT_LATEST_LIMIT = 50;
const DEFAULT_OLDER_LIMIT = 50;

type HistoryQuery = NonNullable<MessagesGetData["query"]>;

function parsePaginatedResponse(
  body: MessagesGetResponse | undefined,
): PaginatedHistoryResult {
  const rows = body?.messages ?? [];

  const messages = rows.map(mapRuntimeToDisplayMessage);

  // Extract notifications and associate each with the id of the last
  // non-notification assistant message (the message that spawned the
  // subagent). This mirrors macOS HistoryReconstructionService.
  const subagentNotifications: RuntimeSubagentNotification[] = [];
  // Completion records re-seed completed inline cards across daemon restarts.
  const backgroundToolCompletions: BackgroundTaskEntry[] = [];
  let lastAssistantMessageId: string | undefined;
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i];
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
    if (m.backgroundToolCompletion) {
      backgroundToolCompletions.push(
        toBackgroundTaskEntryFromCompletion(m.backgroundToolCompletion),
      );
    }
  }

  const hasMore = body?.hasMore ?? false;
  const oldestTimestamp = body?.oldestTimestamp ?? null;
  const oldestMessageId = body?.oldestMessageId || null;
  const seq = body?.seq ?? null;
  // Authoritative "is a turn in flight?" flag. Kept as-is (including
  // `undefined`) rather than coerced to a boolean: `undefined` is the version
  // sentinel that leaves turn-phase behavior untouched for pre-0.8.8 daemons.
  const processing = body?.processing;

  return {
    messages,
    hasMore,
    oldestTimestamp,
    oldestMessageId,
    seq,
    backgroundToolCompletions,
    ...(processing !== undefined ? { processing } : {}),
    ...(subagentNotifications.length > 0 ? { subagentNotifications } : {}),
  };
}

async function fetchPaginatedHistory(
  assistantId: string,
  query: HistoryQuery,
): Promise<PaginatedHistoryResult> {
  const { data, error, response } = await messagesGet({
    path: { assistant_id: assistantId },
    query,
    throwOnError: false,
  });

  assertHasResponse(response, error, "Failed to fetch history");
  if (!response.ok) {
    recordDiagnostic("history_page_fetch_error", {
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

  const result = parsePaginatedResponse(data);
  recordDiagnostic("history_page_fetch", {
    assistantId,
    query,
    status: response.status,
    hasMore: result.hasMore,
    oldestTimestamp: result.oldestTimestamp,
    oldestMessageId: result.oldestMessageId,
    seq: result.seq ?? null,
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
  conversationId: string,
  limit: number = DEFAULT_LATEST_LIMIT,
): Promise<PaginatedHistoryResult> {
  return fetchPaginatedHistory(assistantId, {
    conversationId,
    page: "latest",
    limit,
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
  conversationId: string,
  beforeTimestamp: number,
  limit: number = DEFAULT_OLDER_LIMIT,
): Promise<PaginatedHistoryResult> {
  return fetchPaginatedHistory(assistantId, {
    conversationId,
    beforeTimestamp,
    limit,
  });
}
