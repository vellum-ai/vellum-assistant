/**
 * Chat-domain data models for messages, tool calls, and interaction responses.
 *
 * SSE event types live in `@/types/event-types` (cross-domain shared).
 * This file retains chat-specific data shapes consumed by the transcript,
 * composer, and interaction-handler modules within the chat domain.
 */

import type { ToolActivityMetadata } from "@/assistant/web-activity-types";
import type {
  AllowlistOption,
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

export interface ChatMessageToolCall {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  status: "running" | "completed" | "error";
  result?: string;
  isError?: boolean;
  riskLevel?: string;
  riskReason?: string;
  /** ID of the trust rule that matched this invocation (if any). */
  matchedTrustRuleId?: string;
  /** How the approval decision was reached: "prompted" | "auto" | "blocked" | "unknown". */
  approvalMode?: string;
  /** Why the approval decision was reached (stable enum for client display). */
  approvalReason?: string;
  /** Snapshot of the auto-approve threshold at execution time. */
  riskThreshold?: string;
  allowlistOptions?: AllowlistOption[];
  scopeOptions?: ScopeOption[];
  directoryScopeOptions?: DirectoryScopeOption[];
  pendingConfirmation?: PendingToolConfirmation | null;
  workingDir?: string;
  /** ms since epoch, set locally when tool_use_start SSE event arrives */
  startedAt?: number;
  /** ms since epoch, set locally when tool_result SSE event arrives */
  completedAt?: number;
  /** Explicit decision made during the confirmation flow ("approved" | "denied" | "timed_out"). */
  confirmationDecision?: "approved" | "denied" | "timed_out";
  /**
   * Structured tool activity metadata (e.g. web_search, web_fetch) persisted
   * alongside the tool call so the `WebSearchProgressCard` can keep
   * rendering after the active turn ends and the live `liveWebActivity`
   * map is cleared. Set by `applyToolResult` when the `tool_result` event
   * carries `activityMetadata`. Absent on historical reopens that arrive
   * via reconcile (the server snapshot doesn't carry this field). See
   * `web-activity-types.ts`.
   */
  activityMetadata?: ToolActivityMetadata;
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
