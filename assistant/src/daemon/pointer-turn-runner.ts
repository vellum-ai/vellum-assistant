/**
 * Runs a call pointer/status event as a real daemon conversation turn: the
 * assistant generates the pointer text in-context (identity, preferences,
 * history) rather than emitting deterministic boilerplate.
 *
 * Pointer turns are guardian-gated owner self-maintenance. The turn is
 * tool-disabled and fact-checked: if the model drops a required fact or the
 * agent loop errors, the persisted messages are rolled back and the function
 * throws so the caller can fall back to deterministic copy.
 */

import {
  deleteMessageById,
  getMessages,
} from "../persistence/conversation-crud.js";
import { getLogger } from "../util/logger.js";
import { getOrCreateConversation } from "./conversation-store.js";
import { elevatePointerConversationToGuardian } from "./pointer-conversation-trust.js";

const log = getLogger("pointer-turn-runner");

/**
 * Generate and persist a pointer message as a conversation turn.
 *
 * @param requiredFacts - facts that must appear verbatim in the generated
 *   text (phone number, duration, outcome keyword, etc.). The generated text
 *   is validated against these; if any are missing the turn is rolled back
 *   and this function throws so the caller's deterministic fallback fires.
 * @throws if the agent loop errors or the generated text fails fact validation.
 */
export async function runPointerMessageTurn(
  conversationId: string,
  instruction: string,
  requiredFacts?: string[],
): Promise<void> {
  const conversation = await getOrCreateConversation(conversationId);

  // Pointer turns are guardian-gated owner self-maintenance: elevate to
  // the internal guardian context and rehydrate history so a cold
  // (evicted) load doesn't filter guardian history to empty and ship a
  // cache-missing turn. `restoreTrustContext` undoes the elevation after
  // the turn. See pointer-conversation-trust.ts for the full rationale.
  const restoreTrustContext =
    await elevatePointerConversationToGuardian(conversation);

  // Constrain pointer generation to a tool-disabled path so call-
  // status events cannot trigger unintended side-effect tools.
  // Incrementing toolsDisabledDepth causes the resolveTools callback
  // to return an empty tool list, preventing the LLM from seeing or
  // invoking any tools during the pointer agent loop.
  //
  // A depth counter (rather than a boolean) ensures that overlapping
  // pointer requests on the same conversation don't clear each other's
  // constraint — each caller increments on entry and decrements in
  // its own finally block.
  conversation.toolsDisabledDepth++;
  try {
    const { id: messageId } = await conversation.persistUserMessage({
      content: instruction,
      metadata: { pointerInstruction: true },
      displayContent: "[Call status event]",
    });

    // Helper: roll back persisted messages on failure, then reload
    // in-memory history from the (now cleaned) DB. Reloading avoids
    // stale-index issues when context compaction reassigns the
    // messages array during runAgentLoop.
    const rollback = async (extraMessageIds?: string[]) => {
      try {
        deleteMessageById(messageId);
      } catch {
        /* best effort */
      }
      for (const id of extraMessageIds ?? []) {
        try {
          deleteMessageById(id);
        } catch {
          /* best effort */
        }
      }
      try {
        await conversation.loadFromDb();
      } catch {
        /* best effort */
      }
    };

    // Snapshot message IDs before the agent loop so we can diff
    // afterwards to find exactly which messages this run created,
    // avoiding positional heuristics that break under concurrency.
    //
    // Caveat: the diff captures *all* new messages in the
    // conversation during the loop window, not just those from
    // this specific agent loop.  If a concurrent pointer event
    // falls back to a deterministic addMessage() while our loop
    // is in flight, that message lands in our diff.  The race
    // requires two pointer events for the same conversation
    // within the agent loop window *and* this run must fail or
    // fail fact-check — narrow enough to accept.  A future
    // improvement could tag messages with a per-run correlation
    // ID so rollback only targets its own output.
    const preRunMessageIds = new Set(
      getMessages(conversationId).map((m) => m.id),
    );

    let agentLoopError: string | undefined;
    let generatedText = "";
    await conversation.runAgentLoop(instruction, messageId, {
      onEvent: (msg) => {
        if (
          "type" in msg &&
          msg.type === "assistant_text_delta" &&
          "text" in msg
        ) {
          generatedText += (msg as { text: string }).text;
        }
        if (
          "type" in msg &&
          (msg.type === "error" || msg.type === "conversation_error")
        ) {
          agentLoopError =
            "message" in msg
              ? (msg as { message: string }).message
              : "userMessage" in msg
                ? (msg as { userMessage: string }).userMessage
                : "Agent loop failed";
        }
      },
    });

    // Identify messages created during this run by diffing against
    // the pre-run snapshot. This captures all messages added to the
    // conversation during the loop window, which may include messages
    // from concurrent pointer events (see over-capture caveat above).
    const postRunMessages = getMessages(conversationId);
    const createdMessageIds = postRunMessages
      .filter((m) => !preRunMessageIds.has(m.id) && m.id !== messageId)
      .map((m) => m.id);

    if (agentLoopError) {
      await rollback(createdMessageIds);
      throw new Error(agentLoopError);
    }

    // Post-generation fact check: verify the assistant's response
    // includes all required factual details (phone number, duration,
    // outcome keyword, etc.). If the model omitted or rewrote them,
    // remove both the instruction and generated messages and throw so
    // the deterministic fallback fires.
    //
    // Validation uses text accumulated from assistant_text_delta
    // events during the agent loop rather than a DB lookup, avoiding
    // any positional ambiguity when concurrent pointer events
    // interleave messages in the conversation.
    if (requiredFacts && requiredFacts.length > 0) {
      const missingFacts = requiredFacts.filter(
        (fact) => !generatedText.includes(fact),
      );
      if (missingFacts.length > 0) {
        log.warn(
          { conversationId, missingFacts },
          "Generated pointer text failed fact validation — falling back to deterministic",
        );
        await rollback(createdMessageIds);
        throw new Error("Generated pointer text failed fact validation");
      }
    }
  } finally {
    // Restore tool availability so subsequent turns aren't affected.
    conversation.toolsDisabledDepth--;
    // Undo the temporary guardian elevation installed above.
    restoreTrustContext();
  }
}
