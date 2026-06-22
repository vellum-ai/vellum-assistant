/**
 * Render-time enrichment of history tool calls with in-flight question context.
 *
 * `pendingQuestion` — the outstanding `ask_question` prompt for a tool call
 * still awaiting a user answer — is read from the in-memory
 * `pending-interactions` registry (the authoritative store of unresolved
 * prompts) and stamped onto its tool call so the web/API clients can restore
 * the same question card on a cold reconnect (or a history reopen after the
 * live event buffer has aged out) that the live `question_request` SSE stream
 * would have produced. It appears only while the prompt is genuinely
 * outstanding. Mirrors the confirmation enrichment in
 * `tool-call-confirmation-enrichment.ts`.
 */

import type { QuestionEntry } from "../../api/events/question-request.js";
import type { ConversationMessageToolCall } from "../../api/responses/conversation-message.js";
import { getByConversation } from "../pending-interactions.js";

/** A pending question matched to the tool call it prompts for, keyed by `toolUseId`. */
interface PendingQuestionMatch {
  requestId: string;
  entries: QuestionEntry[];
}

/**
 * Build the `toolUseId → pending question` lookup for a conversation from the
 * registry. Only question interactions that carry both a `toolUseId` and
 * `questionDetails` can be stamped onto a wire tool call.
 */
export function collectPendingQuestions(
  conversationId: string,
): Map<string, PendingQuestionMatch> {
  const byToolUseId = new Map<string, PendingQuestionMatch>();
  for (const interaction of getByConversation(conversationId)) {
    if (
      interaction.kind === "question" &&
      interaction.questionDetails &&
      interaction.toolUseId
    ) {
      byToolUseId.set(interaction.toolUseId, {
        requestId: interaction.requestId,
        entries: interaction.questionDetails.entries,
      });
    }
  }
  return byToolUseId;
}

/**
 * Layer any outstanding `pendingQuestion` onto a message's rendered tool calls.
 * Returns a new array; tool calls without a match are returned unchanged.
 */
export function enrichToolCallsWithQuestion(
  toolCalls: ConversationMessageToolCall[],
  opts: { pendingQuestions: ReadonlyMap<string, PendingQuestionMatch> },
): ConversationMessageToolCall[] {
  if (opts.pendingQuestions.size === 0) return toolCalls;
  return toolCalls.map((tc) => {
    const match = tc.id ? opts.pendingQuestions.get(tc.id) : undefined;
    if (!match) return tc;
    return {
      ...tc,
      pendingQuestion: { requestId: match.requestId, entries: match.entries },
    };
  });
}
