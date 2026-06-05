/**
 * Chat-domain data models for messages, tool calls, and interaction responses.
 *
 * SSE event types live in `@/types/event-types` (cross-domain shared).
 * This file retains chat-specific data shapes consumed by the transcript,
 * composer, and interaction-handler modules within the chat domain.
 */

import type {
  AllowlistOption,
  ConversationMessageToolCall,
  DirectoryScopeOption,
  QuestionEntry,
  QuestionRequestEvent,
  ScopeOption,
} from "@vellumai/assistant-api";

/** Data needed to render an inline permission prompt inside a ToolCallChip. */
export interface PendingToolConfirmation {
  requestId: string;
  title?: string;
  description?: string;
  toolName?: string;
  riskLevel?: string;
  riskReason?: string;
  input?: Record<string, unknown>;
  allowlistOptions?: AllowlistOption[];
  scopeOptions?: ScopeOption[];
  directoryScopeOptions?: DirectoryScopeOption[];
  persistentDecisionsAllowed?: boolean;
}

/**
 * A tool call as rendered in the transcript. Extends the canonical wire
 * `ConversationMessageToolCall` (carrying `name`, `input`, `result`, the
 * risk/approval fields, the `risk*Options` rule-editor ladders, the
 * `confirmationDecision` outcome, and the activity metadata) with the
 * client-only live state the wire deliberately omits — the in-flight
 * confirmation prompt and its scope context. Execution
 * state (`running`/`completed`/`error`) is not stored: derive it on demand
 * from `isError`/`result`/`completedAt` via the predicates in
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
   * Scope ladder offered by the confirmation flow (`{label, scope}`). Sourced
   * from the `confirmation_request` event — distinct from the inherited
   * regex-flavored `riskScopeOptions` (`{pattern, label}`) the rule editor uses.
   */
  scopeOptions?: ScopeOption[];
  pendingConfirmation?: PendingToolConfirmation | null;
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
