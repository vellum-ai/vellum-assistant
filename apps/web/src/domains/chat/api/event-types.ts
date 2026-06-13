/**
 * Chat-domain data models for messages, tool calls, and interaction responses.
 *
 * SSE event types live in `@/types/event-types` (cross-domain shared).
 * This file retains chat-specific data shapes consumed by the transcript,
 * composer, and interaction-handler modules within the chat domain.
 */

import type {
  ConversationMessageToolCall,
  QuestionEntry,
  QuestionRequestEvent,
} from "@vellumai/assistant-api";

/**
 * A tool call as rendered in the transcript. Extends the canonical wire
 * `ConversationMessageToolCall` (carrying `name`, `input`, `result`, the
 * risk/approval fields, the `risk*Options` rule-editor ladders, the
 * `confirmationDecision` outcome, the activity metadata, the confirmation
 * `scopeOptions`, and — as of daemon v0.8.8 — the in-flight
 * `pendingConfirmation` read from the pending-interactions registry at render
 * time). The client clears `pendingConfirmation` by setting it back to
 * `undefined` once a prompt resolves, matching the wire's optional shape.
 * Execution state (`running`/`completed`/`error`) is not stored: derive it on
 * demand from `isError`/`result`/`completedAt` via the predicates in
 * `tool-call-status.ts` (`isToolCallRunning`/`isToolCallCompleted`).
 */
export interface ChatMessageToolCall extends ConversationMessageToolCall {
  /**
   * Stable tool-call id, required for the client's keying (React keys, the
   * `expandedToolCallIds` set, the `liveWebActivity` map, reconcile's
   * snapshot/stream match). The daemon guarantees an id on every wire tool call
   * as of v0.8.8 (the provider tool-use id, or a synthesized positional id), so
   * this narrows the inherited optional wire `id` to required at the ingest
   * boundary — `mapRuntimeToolCalls` only re-synthesizes for daemons `< 0.8.8`.
   * Drop this narrowing once the wire `id` graduates to non-optional.
   */
  id: string;
  /**
   * Client-only marker for a tool call ingested from `tool_use_preview_start`
   * — the model is still streaming the call's arguments, so `input` is empty
   * and no execution has begun. Cleared (set `false`) when the matching
   * `tool_use_start` upgrades the entry with real input. Previews are
   * ephemeral: they are never force-completed by turn finalization and are
   * removed on idle if no `tool_use_start` ever arrived (aborted mid-call).
   */
  isPreview?: boolean;
}

// ---------------------------------------------------------------------------
// Interaction response types
// ---------------------------------------------------------------------------

export type QuestionResponseEntry =
  | { questionId: string; kind: "option"; optionId: string }
  | { questionId: string; kind: "free_text"; text: string }
  | { questionId: string; kind: "skip" };

export type QuestionSubmission =
  | { kind: "submit"; responses: QuestionResponseEntry[] }
  | { kind: "close" };

/**
 * Normalizes a `question_request` SSE event into the batched `QuestionEntry[]`
 * shape. Handles both the new batched format (daemon >= v0.9) and the legacy
 * single-question flat format from older daemons.
 */
export function normalizeQuestionRequest(
  event: QuestionRequestEvent,
): QuestionEntry[] {
  if (event.questions && event.questions.length > 0) {
    return event.questions.map((entry, i) => ({
      id:
        typeof entry.id === "string" && entry.id.trim() !== ""
          ? entry.id
          : `q${i + 1}`,
      question: entry.question ?? "",
      description: entry.description,
      options: Array.isArray(entry.options) ? entry.options : [],
      freeTextPlaceholder: entry.freeTextPlaceholder,
    }));
  }
  const hasLegacyFields =
    event.question !== undefined ||
    event.options !== undefined ||
    event.description !== undefined ||
    event.freeTextPlaceholder !== undefined;
  if (hasLegacyFields) {
    return [
      {
        id: "q1",
        question: event.question ?? "",
        description: event.description,
        options: Array.isArray(event.options) ? event.options : [],
        freeTextPlaceholder: event.freeTextPlaceholder,
      },
    ];
  }
  return [];
}
