/**
 * Shared types for the (chat) route segment.
 *
 * Feature-scoped interfaces that are consumed by multiple files within this
 * directory (hooks, components, the page client) live here rather than being
 * inlined in a single consumer.
 */

import type {
  AllowlistOption,
  DirectoryScopeOption,
  QuestionEntry,
  ScopeOption,
} from "@/domains/chat/lib/api.js";

import type { AssistantState } from "@/domains/chat/hooks/use-assistant-lifecycle.js";

// ---------------------------------------------------------------------------
// Assistant state
// ---------------------------------------------------------------------------

/** The `kind` discriminant of `AssistantState`, shared across multiple hooks. */
export type AssistantStateKind = AssistantState["kind"];

// ---------------------------------------------------------------------------
// State shapes used by AssistantPageClient for prompt / error UI
// ---------------------------------------------------------------------------

export interface ChatError {
  message: string;
  code?: string;
  errorCategory?: string;
}

export interface PendingSecretState {
  requestId: string;
  label?: string;
  description?: string;
  placeholder?: string;
  allowOneTimeSend?: boolean;
  allowedTools?: string[];
  allowedDomains?: string[];
  purpose?: string;
}

export interface PendingConfirmationState {
  requestId: string;
  title?: string;
  description?: string;
  confirmLabel?: string;
  denyLabel?: string;
  toolName?: string;
  riskLevel?: string;
  riskReason?: string;
  allowlistOptions?: AllowlistOption[];
  scopeOptions?: ScopeOption[];
  directoryScopeOptions?: DirectoryScopeOption[];
  persistentDecisionsAllowed?: boolean;
  input?: Record<string, unknown>;
  toolUseId?: string;
}

export interface PendingContactRequestState {
  requestId: string;
  channel?: string;
  placeholder?: string;
  label?: string;
  description?: string;
  role?: string;
}

export interface PendingQuestionState {
  requestId: string;
  /**
   * Normalized list of questions for the card. Always ≥1; legacy
   * single-question payloads are flattened to a one-element batch by
   * `normalizeQuestionRequest` upstream.
   */
  entries: QuestionEntry[];
  toolUseId?: string;
}
