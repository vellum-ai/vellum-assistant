import { getMessageById } from "../../memory/conversation-crud.js";
import {
  listConversations,
  searchConversations,
} from "../../memory/conversation-queries.js";
import { renderHistoryContent } from "./shared.js";

// ---------------------------------------------------------------------------
// Shared business logic (transport-agnostic)
// ---------------------------------------------------------------------------

export interface ConversationSearchParams {
  query: string;
  limit?: number;
  maxMessagesPerConversation?: number;
}

/** Search conversations and return results (no transport dependency). */
export function performConversationSearch(params: ConversationSearchParams) {
  // Treat "*" as a list-all wildcard — FTS treats it as a literal character.
  if (params.query.trim() === "*") {
    const rows = listConversations(params.limit);
    return rows.map((r) => ({
      conversationId: r.id,
      conversationTitle: r.title,
      conversationUpdatedAt: r.updatedAt,
      matchingMessages: [],
    }));
  }
  return searchConversations(params.query, {
    limit: params.limit,
    maxMessagesPerConversation: params.maxMessagesPerConversation,
  });
}

export interface MessageContentResult {
  sessionId?: string;
  messageId: string;
  text?: string;
  toolCalls?: Array<{
    name: string;
    result?: string;
    input?: Record<string, unknown>;
  }>;
}

/**
 * Get the full content of a single message by ID.
 * Returns null if the message is not found.
 */
export function getMessageContent(
  messageId: string,
  sessionId?: string,
): MessageContentResult | null {
  const dbMessage = getMessageById(messageId, sessionId);
  if (!dbMessage) return null;

  let text: string | undefined;
  let toolCalls:
    | Array<{ name: string; result?: string; input?: Record<string, unknown> }>
    | undefined;

  try {
    const content = JSON.parse(dbMessage.content);
    const rendered = renderHistoryContent(content);
    text = rendered.text || undefined;
    const parsedToolCalls = rendered.toolCalls;

    if (parsedToolCalls.length > 0) {
      toolCalls = parsedToolCalls.map((tc) => ({
        name: tc.name,
        input: tc.input,
        ...(tc.result !== undefined ? { result: tc.result } : {}),
      }));
    }
  } catch {
    // Raw text content (not JSON)
    text = dbMessage.content || undefined;
  }

  return {
    sessionId,
    messageId,
    ...(text !== undefined ? { text } : {}),
    ...(toolCalls ? { toolCalls } : {}),
  };
}
