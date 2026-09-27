import { isToolResultOnlyUserMessage } from "../conversations/message-consolidation.js";
import { getAttentionStateByConversationIds } from "../persistence/conversation-attention-store.js";
import {
  getMessageById,
  getMessagesAfter,
  getRecentConversationMessages,
  isStandaloneAssistantMessage,
  type MessageRow,
} from "../persistence/conversation-crud.js";
import { stringifyMessageContent } from "../persistence/message-content.js";
import {
  isPrivateAssistantText,
  projectPersistedAssistantContent,
} from "../persistence/user-facing-content.js";
import {
  decodeLiteralLineBreaks,
  stripMarkdownForPreview,
  truncate,
} from "./notification-utils.js";

const MAX_RESULT_BODY_CHARS = 2000;
const RUN_HISTORY_PAGE_SIZE = 200;

/** A messaging delivery counts only after its matching tool result succeeds.
 * Missing or failed results leave the fallback available. */
export function deliveredThroughMessagingTool(
  conversationId: string,
  runRows: readonly MessageRow[],
): boolean {
  const callIds = new Set<string>();
  for (const row of runRows) {
    for (const block of row.content) {
      if (block.type === "tool_use" && block.name === "messaging_send") {
        callIds.add(block.id);
      }
    }
  }
  if (callIds.size === 0) {
    return false;
  }
  const [firstRunRow] = runRows;
  for (const row of getMessagesAfter(conversationId, {
    id: firstRunRow.id,
    createdAt: firstRunRow.createdAt,
  })) {
    if (row.role !== "user") {
      continue;
    }
    for (const block of row.content) {
      // guard:allow-tool-result-only: the local executor's verdict on a
      // delivery it ran. A server-side `web_search_tool_result` carries no
      // `is_error` and never delivers anything.
      if (
        block.type === "tool_result" &&
        block.is_error !== true &&
        callIds.has(block.tool_use_id)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Read the assistant rows of one turn, bounded by the run start. */
export function collectRunRows(
  latestRow: MessageRow,
  conversationId: string,
  runStartedAt: number,
): MessageRow[] {
  if (latestRow.createdAt < runStartedAt) {
    return [];
  }
  const rows: MessageRow[] = [latestRow];
  if (isStandaloneAssistantMessage(latestRow.role, latestRow.metadata)) {
    return rows;
  }
  let beforeMessageId = latestRow.id;
  while (true) {
    const history = getRecentConversationMessages(
      conversationId,
      RUN_HISTORY_PAGE_SIZE,
      beforeMessageId,
    );
    for (let index = history.length - 1; index >= 0; index--) {
      const row = history[index];
      if (
        isStandaloneAssistantMessage(row.role, row.metadata) ||
        (row.role === "user" && !isToolResultOnlyUserMessage(row))
      ) {
        return rows.reverse();
      }
      if (row.role === "assistant" && row.createdAt >= runStartedAt) {
        rows.push(row);
      }
    }
    if (history.length < RUN_HISTORY_PAGE_SIZE) {
      return rows.reverse();
    }
    beforeMessageId = history[0].id;
  }
}

/** Read the persisted user-facing result, walking back through private wrap-up
 * rows. Keep markdown for the feed detail panel; flatten only to check emptiness. */
export function resolveRunResult(
  runRows: readonly MessageRow[],
): { body: string; row: MessageRow } | undefined {
  for (let i = runRows.length - 1; i >= 0; i--) {
    const row = runRows[i];
    const text = stringifyMessageContent(
      projectPersistedAssistantContent(row.content, row.metadata),
    );
    const flattened = stripMarkdownForPreview(text).replace(/\s+/g, " ").trim();
    if (flattened) {
      return {
        body: truncate(
          decodeLiteralLineBreaks(text.trim()),
          MAX_RESULT_BODY_CHARS,
        ),
        row,
      };
    }
    if (!isPrivateAssistantText(row.metadata)) {
      return undefined;
    }
  }
  return undefined;
}

export function resolveRunOutput(
  runRows: readonly MessageRow[],
): string | undefined {
  return resolveRunResult(runRows)?.body;
}

/** Read the final assistant row only when it belongs to this run. */
export function resolveLatestRunRow(
  conversationId: string,
  runStartedAt: number,
): MessageRow | undefined {
  const attention = getAttentionStateByConversationIds([conversationId]).get(
    conversationId,
  );
  const assistantMessageId = attention?.latestAssistantMessageId;
  if (!assistantMessageId) {
    return undefined;
  }
  const row = getMessageById(assistantMessageId, conversationId);
  if (!row || row.createdAt < runStartedAt) {
    return undefined;
  }
  return row;
}
