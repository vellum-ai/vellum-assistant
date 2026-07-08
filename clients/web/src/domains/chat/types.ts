/**
 * Shared types for the (chat) route segment.
 *
 * Feature-scoped interfaces that are consumed by multiple files within this
 * directory (hooks, components, the page client) live here rather than being
 * inlined in a single consumer.
 */


import type { AssistantState } from "@/assistant/types";
import type { AllowlistOption, DirectoryScopeOption, QuestionEntry, ScopeOption } from "@/types/interaction-ui-types";

// ---------------------------------------------------------------------------
// Assistant state
// ---------------------------------------------------------------------------

/** The `kind` discriminant of `AssistantState`, shared across multiple hooks. */
export type AssistantStateKind = AssistantState["kind"];

// ---------------------------------------------------------------------------
// State shapes for prompt / error UI
// ---------------------------------------------------------------------------

export interface ChatError {
  message: string;
  code?: string;
  errorCategory?: string;
  /**
   * How the UI should surface this error.
   * - "inline" (default): render as a Notice banner in the composer area.
   * - "modal": render as a blocking dialog. Used when the POST failed before
   *   any optimistic state was committed (e.g. secret_blocked from a fresh
   *   draft conversation) so the user is interrupted and can act on it.
   */
  displayAs?: "inline" | "modal";
  /**
   * Original user-typed content to restore into the composer when the error
   * is acknowledged. Set alongside `displayAs: "modal"` so the user doesn't
   * lose their message after a failed send rollback.
   */
  restoreContent?: string;
  /**
   * URL the banner offers to open via an action button. Set when an
   * automatic `window.open` was blocked (no user activation on SSE-driven
   * opens) — the button click is a real user gesture, so it succeeds.
   */
  actionUrl?: string;
}

export interface PendingSecretState {
  requestId: string;
  label?: string;
  service?: string;
  field?: string;
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
