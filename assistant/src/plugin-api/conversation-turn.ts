/**
 * Plugin-facing facade for running a full conversation agent-loop turn.
 *
 * This is the conversation-scoped equivalent of the daemon's
 * `processMessage` path: it persists a user message, runs the agent loop
 * (with all its machinery -- system prompt construction, conversation
 * history, tool use cycles, compaction, injections), and returns the
 * assistant's full content-block response.
 *
 * Plugins that need to drive conversation turns (e.g. meeting-bot
 * flushing a transcript excerpt) should prefer this over the stateless
 * `provider.sendMessage()` call, which has no history, no tools, and no
 * context management.
 */

import type { LLMCallSite } from "../config/schemas/llm.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { UserMessageAttachment } from "../daemon/message-types/shared.js";
import type { ContentBlock, MediaSource } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunConversationTurnOptions {
  /**
   * Conversation to run the turn in. If omitted, a new conversation is
   * created (its ID is generated with `uuidv7` and returned in the result).
   */
  conversationId?: string;
  /**
   * User message content blocks for this turn. Text blocks become the
   * user message body; image/file blocks are resolved to inline
   * attachments. Other block types (tool_use, tool_result, thinking) are
   * ignored as they are not valid user input.
   */
  content: ContentBlock[];
  /**
   * LLM call-site for inference profile resolution. Defaults to
   * `"mainAgent"` inside the agent loop when omitted.
   */
  callSite?: LLMCallSite;
  /**
   * Abort signal. When aborted, the conversation's internal abort
   * controller fires, terminating the in-flight agent loop.
   */
  signal?: AbortSignal;
}

export interface RunConversationTurnResult {
  /** The assistant's full content blocks for this turn (text, tool_use, etc.). */
  content: ContentBlock[];
  /** The user message row ID assigned by the persistence layer. */
  userMessageId: string;
  /** The conversation this turn ran in. */
  conversationId: string;
  /** True when the message was queued because the conversation was busy. */
  queued?: boolean;
}

// ---------------------------------------------------------------------------
// Content conversion
// ---------------------------------------------------------------------------

/**
 * Extract a plain-text content string and attachment list from
 * {@link ContentBlock} input. Text blocks are concatenated (newline
 * separated); image and file blocks are converted to
 * {@link UserMessageAttachment} entries with their media source resolved
 * to inline base64. Other block types are ignored.
 */
function extractContentAndAttachments(
  blocks: ContentBlock[],
  resolveMedia: (source: MediaSource) => { data: string; media_type: string } | null,
): { text: string; attachments: UserMessageAttachment[] } {
  const textParts: string[] = [];
  const attachments: UserMessageAttachment[] = [];

  for (const block of blocks) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "image" || block.type === "file") {
      const source = block.source;
      const resolved = resolveMedia(source);
      if (resolved) {
        attachments.push({
          filename:
            source.filename ?? (block.type === "image" ? "image" : "file"),
          mimeType: resolved.media_type,
          data: resolved.data,
          ...(block.type === "file" && block.extracted_text
            ? { extractedText: block.extracted_text }
            : {}),
        });
      }
    }
  }

  return { text: textParts.join("\n"), attachments };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a full conversation agent-loop turn: persist the user message, execute
 * the agent loop (history, tools, compaction, injections), and return the
 * assistant's full content-block response.
 *
 * When `conversationId` is omitted, a new conversation is created and its ID
 * is returned in the result.
 *
 * Events are fanned out to SSE/event-hub subscribers via `broadcastMessage`
 * (the same path the daemon's HTTP message route uses) while also being
 * collected internally so the caller receives the final response content.
 * For streaming use cases, subscribe to the conversation's events via the
 * host event hub (`assistantEventHub`).
 *
 * If the conversation is currently processing another turn, the message is
 * queued via `enqueueMessage` and the result carries `queued: true` with
 * empty content -- the queued turn will execute automatically when the
 * current turn finishes.
 */
export async function runConversationTurn(
  options: RunConversationTurnOptions,
): Promise<RunConversationTurnResult> {
  const { v7: uuidv7 } = await import("uuid");
  const { getOrCreateConversation } = await import(
    "../daemon/conversation-store.js"
  );
  const { broadcastMessage } = await import(
    "../runtime/assistant-event-hub.js"
  );
  const { resolveMediaSourceData } = await import(
    "../providers/media-resolve.js"
  );
  const { getMessageById, getMessages } = await import(
    "../persistence/conversation-crud.js"
  );

  const conversationId = options.conversationId ?? uuidv7();
  const conversation = await getOrCreateConversation(conversationId);

  // Wire the external abort signal to the conversation's internal abort
  // controller so aborting the signal terminates the in-flight agent loop.
  if (options.signal) {
    options.signal.addEventListener("abort", () => {
      conversation.abortController?.abort();
    });
  }

  // Convert ContentBlock[] input to the text + attachments shape the
  // conversation's processMessage path expects.
  const { text, attachments } = extractContentAndAttachments(
    options.content,
    resolveMediaSourceData,
  );

  // Build the event emitter: fan out to SSE/event-hub subscribers via
  // broadcastMessage, then invoke the collector callback. This mirrors the
  // buildEventEmitter pattern from process-message.ts so plugin-driven
  // turns reach the same subscribers as HTTP-driven turns.
  let assistantMessageId: string | undefined;
  const onEvent = (msg: ServerMessage): void => {
    broadcastMessage(msg, conversationId);
    if (msg.type === "message_complete" && msg.messageId) {
      assistantMessageId = msg.messageId;
    }
  };

  // When the conversation is busy, enqueue the message instead of rejecting.
  // The queue is drained automatically when the current turn finishes.
  if (conversation.isProcessing()) {
    const requestId = uuidv7();
    const enqueueResult = conversation.enqueueMessage({
      content: text,
      attachments,
      onEvent,
      requestId,
      isInteractive: false,
    });
    if (enqueueResult.rejected) {
      throw new Error(
        "Conversation is busy and its message queue is full. Try again later.",
      );
    }
    return {
      content: [],
      userMessageId: requestId,
      conversationId,
      queued: true,
    };
  }

  const userMessageId = await conversation.processMessage({
    content: text,
    attachments,
    onEvent,
    isInteractive: false,
    ...(options.callSite ? { callSite: options.callSite } : {}),
  });

  // Retrieve the assistant's full content blocks from the persisted
  // message row. The message_complete event carries the assistant
  // message ID; if it was captured, use it directly. Otherwise fall back
  // to scanning the conversation's messages for the first assistant
  // message after our user message.
  let assistantContent: ContentBlock[] = [];
  if (assistantMessageId) {
    const assistantRow = getMessageById(assistantMessageId, conversationId);
    if (assistantRow) {
      assistantContent = assistantRow.content;
    }
  }
  if (assistantContent.length === 0) {
    const allMessages = getMessages(conversationId);
    const userIdx = allMessages.findIndex((m) => m.id === userMessageId);
    if (userIdx >= 0) {
      for (let i = allMessages.length - 1; i > userIdx; i--) {
        if (allMessages[i].role === "assistant") {
          assistantContent = allMessages[i].content;
          break;
        }
      }
    }
  }

  return {
    content: assistantContent,
    userMessageId,
    conversationId,
  };
}
