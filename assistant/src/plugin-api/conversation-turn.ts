/**
 * Plugin-facing facade for running a full conversation agent-loop turn.
 *
 * This is the conversation-scoped equivalent of the daemon's
 * `processMessage` path: it persists a user message, runs the agent loop
 * (with all its machinery — system prompt construction, conversation
 * history, tool use cycles, compaction, injections), and returns the
 * assistant's text response.
 *
 * Plugins that need to drive conversation turns (e.g. meeting-bot
 * flushing a transcript excerpt) should prefer this over the stateless
 * `provider.sendMessage()` call, which has no history, no tools, and no
 * context management.
 */

import type { LLMCallSite } from "../config/schemas/llm.js";
import type { ServerMessage } from "../daemon/message-protocol.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunConversationTurnOptions {
  /** Conversation to run the turn in. Must already exist in the store. */
  conversationId: string;
  /** User message content for this turn. */
  content: string;
  /**
   * LLM call-site for inference profile resolution. Defaults to
   * `"mainAgent"` inside the agent loop when omitted.
   */
  callSite?: LLMCallSite;
  /** Abort signal. */
  signal?: AbortSignal;
}

export interface RunConversationTurnResult {
  /** The assistant's full text response for this turn. */
  text: string;
  /** The user message row ID assigned by the persistence layer. */
  messageId: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a full conversation agent-loop turn: persist the user message, execute
 * the agent loop (history, tools, compaction, injections), and return the
 * assistant's text response.
 *
 * The conversation must already exist (created via the host's normal
 * conversation-creation paths). This facade reuses the same
 * `Conversation.processMessage` path the daemon's HTTP message route uses,
 * so the turn gets the full machinery: system prompt from IDENTITY.md /
 * SOUL.md / USER.md, conversation history from the DB, tool use cycles,
 * context compaction, and default-plugin injections.
 *
 * Events are collected internally — the caller receives the final text
 * response, not a stream. For streaming use cases, use the host's event hub
 * (`assistantEventHub`) to subscribe to the conversation's events.
 */
export async function runConversationTurn(
  options: RunConversationTurnOptions,
): Promise<RunConversationTurnResult> {
  const { getOrCreateConversation } = await import(
    "../daemon/conversation-store.js"
  );

  const conversation = await getOrCreateConversation(options.conversationId);

  // Collect assistant text deltas as they stream from the agent loop.
  let responseText = "";
  const onEvent = (msg: ServerMessage) => {
    if (msg.type === "assistant_text_delta") {
      responseText += msg.text;
    }
  };

  const messageId = await conversation.processMessage({
    content: options.content,
    attachments: [],
    onEvent,
    isInteractive: false,
    ...(options.callSite ? { callSite: options.callSite } : {}),
  });

  return { text: responseText, messageId };
}
