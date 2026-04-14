import {
  getMessageById,
  getMessagesPaginated,
  type MessageRow,
} from "../../memory/conversation-crud.js";
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

// ---------------------------------------------------------------------------
// Conversation history (paginated)
// ---------------------------------------------------------------------------

export interface ConversationHistoryMessage {
  id: string;
  role: "user" | "assistant";
  text?: string;
  toolCalls?: Array<{
    name: string;
    input?: Record<string, unknown>;
    result?: string;
  }>;
  createdAt: number;
}

export interface ConversationHistoryResult {
  conversationId: string;
  messages: ConversationHistoryMessage[];
  hasMore: boolean;
  nextBeforeTimestamp?: number;
}

// ---------------------------------------------------------------------------
// Tool-result merging (mirrors conversation-routes.ts logic)
// ---------------------------------------------------------------------------

function isToolResultType(type: string): boolean {
  return type === "tool_result" || type === "web_search_tool_result";
}

function isSystemNoticeText(block: Record<string, unknown>): boolean {
  if (block.type !== "text") return false;
  const text = typeof block.text === "string" ? block.text : "";
  return (
    text.startsWith("<system_notice>") && text.endsWith("</system_notice>")
  );
}

/**
 * Merge tool_result blocks from user messages into the preceding assistant
 * message's content array so that renderHistoryContent can pair tool_use
 * and tool_result blocks via its pendingToolUses map.
 *
 * User messages consisting entirely of tool_result blocks (and optional
 * system_notice text) are removed. Mixed messages keep only the
 * non-tool-result blocks.
 */
function mergeToolResultsIntoAssistantMessages(
  messages: MessageRow[],
): MessageRow[] {
  let lastAssistantIdx = -1;
  const parsedAssistantContent = new Map<number, unknown[]>();
  const result: MessageRow[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      lastAssistantIdx = result.length;
      result.push(msg);
      continue;
    }

    if (msg.role !== "user") {
      result.push(msg);
      continue;
    }

    let blocks: unknown[];
    try {
      const parsed = JSON.parse(msg.content);
      if (!Array.isArray(parsed)) {
        result.push(msg);
        continue;
      }
      blocks = parsed;
    } catch {
      result.push(msg);
      continue;
    }

    const toolResultBlocks: unknown[] = [];
    const otherBlocks: unknown[] = [];
    for (const block of blocks) {
      if (
        typeof block === "object" &&
        block !== null &&
        typeof (block as Record<string, unknown>).type === "string"
      ) {
        const rec = block as Record<string, unknown>;
        if (isToolResultType(rec.type as string)) {
          toolResultBlocks.push(block);
        } else {
          otherBlocks.push(block);
        }
      } else {
        otherBlocks.push(block);
      }
    }

    if (toolResultBlocks.length === 0) {
      result.push(msg);
      continue;
    }

    if (lastAssistantIdx >= 0) {
      const assistant = result[lastAssistantIdx];
      let assistantContent = parsedAssistantContent.get(lastAssistantIdx);
      if (!assistantContent) {
        try {
          const parsed = JSON.parse(assistant.content);
          assistantContent = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          assistantContent = [];
        }
        parsedAssistantContent.set(lastAssistantIdx, assistantContent);
      }
      assistantContent.push(...toolResultBlocks);
    } else {
      // No preceding assistant message (pagination boundary) — keep the
      // original message as-is to avoid data loss. Strip system notices.
      const filteredBlocks = blocks.filter(
        (b) =>
          !(
            typeof b === "object" &&
            b !== null &&
            isSystemNoticeText(b as Record<string, unknown>)
          ),
      );
      result.push({
        ...msg,
        content:
          filteredBlocks.length === blocks.length
            ? msg.content
            : JSON.stringify(filteredBlocks),
      });
      continue;
    }

    // If the user message had only tool_result (+ system_notice) blocks,
    // suppress it. Otherwise keep the non-tool-result content.
    const realUserContent = otherBlocks.filter(
      (b) =>
        !(
          typeof b === "object" &&
          b !== null &&
          isSystemNoticeText(b as Record<string, unknown>)
        ),
    );
    if (realUserContent.length > 0) {
      result.push({ ...msg, content: JSON.stringify(otherBlocks) });
    }
  }

  // Write back modified assistant message content.
  for (const [idx, content] of parsedAssistantContent) {
    result[idx] = { ...result[idx], content: JSON.stringify(content) };
  }

  return result;
}

/** Return paginated messages for a conversation, oldest-first. */
export function listConversationMessages(
  conversationId: string,
  limit: number,
  beforeTimestamp?: number,
): ConversationHistoryResult {
  const { messages: rawRows, hasMore } = getMessagesPaginated(
    conversationId,
    limit,
    beforeTimestamp,
  );

  // Merge tool_result blocks from user rows into the preceding assistant
  // message before rendering, so renderHistoryContent can pair tool_use
  // and tool_result blocks correctly.
  const rows = mergeToolResultsIntoAssistantMessages(rawRows);

  const messages: ConversationHistoryMessage[] = rows.map((row) => {
    const role: "user" | "assistant" =
      row.role === "user" ? "user" : "assistant";
    let text: string | undefined;
    let toolCalls:
      | Array<{
          name: string;
          input?: Record<string, unknown>;
          result?: string;
        }>
      | undefined;

    try {
      const content = JSON.parse(row.content);
      const rendered = renderHistoryContent(content);
      text = rendered.text || undefined;
      if (rendered.toolCalls.length > 0) {
        toolCalls = rendered.toolCalls.map((tc) => ({
          name: tc.name,
          input: tc.input,
          ...(tc.result !== undefined ? { result: tc.result } : {}),
        }));
      }
    } catch {
      text = row.content || undefined;
    }

    return {
      id: row.id,
      role,
      ...(text !== undefined ? { text } : {}),
      ...(toolCalls ? { toolCalls } : {}),
      createdAt: row.createdAt,
    };
  });

  return {
    conversationId,
    messages,
    hasMore,
    nextBeforeTimestamp:
      hasMore && messages.length > 0 ? messages[0].createdAt : undefined,
  };
}

// ---------------------------------------------------------------------------
// Single message content
// ---------------------------------------------------------------------------

export interface MessageContentResult {
  conversationId?: string;
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
  conversationId?: string,
): MessageContentResult | null {
  const dbMessage = getMessageById(messageId, conversationId);
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
    conversationId,
    messageId,
    ...(text !== undefined ? { text } : {}),
    ...(toolCalls ? { toolCalls } : {}),
  };
}
