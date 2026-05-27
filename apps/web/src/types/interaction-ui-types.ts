/**
 * Pure interface types consumed by the interaction state machine and
 * other state-management modules. Framework-agnostic — no routing or
 * SSR dependencies.
 */

// ---------------------------------------------------------------------------
// Confirmation / secret / contact / question request shapes
// ---------------------------------------------------------------------------

export interface AllowlistOption {
  /** Short display label for the radio row in the rule editor. */
  label: string;
  /**
   * Optional longer-form description shown beneath/alongside the label.
   * Daemon includes this on `riskAllowlistOptions` (shared with macOS); the
   * web modal renders the label today and may surface description later.
   */
  description?: string;
  /**
   * Minimatch-glob compatible pattern saved as the trust rule's `pattern`
   * field. The gateway matches incoming tool calls against this string —
   * it is NOT a regex despite some legacy emit sites prefixing with `^`.
   * See `gateway/src/risk/bash-risk-classifier.ts` for the matching contract.
   */
  pattern: string;
}

export interface ScopeOption {
  label: string;
  scope: string;
}

export interface DirectoryScopeOption {
  label: string;
  scope: string;
}

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface QuestionEntry {
  id: string;
  question: string;
  description?: string;
  options: QuestionOption[];
  freeTextPlaceholder?: string;
}

// ---------------------------------------------------------------------------
// Chat UI state types — used by interaction store and chat domain
// ---------------------------------------------------------------------------

export interface ChatError {
  message: string;
  code?: string;
  errorCategory?: string;
  /** See `types.ts` ChatError for full semantics. */
  displayAs?: "inline" | "modal";
  /** See `types.ts` ChatError for full semantics. */
  restoreContent?: string;
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
  entries: QuestionEntry[];
  toolUseId?: string;
}

// ---------------------------------------------------------------------------
// Subagent event types — used by subagent domain and chat SSE stream
// ---------------------------------------------------------------------------

export type SubagentStatus = "pending" | "running" | "awaiting_input" | "completed" | "failed" | "aborted";

export interface SubagentInnerEvent {
  type: string;
  content?: string;
  /** `assistant_text_delta` events carry text in `text`, not `content`. */
  text?: string;
  /** `tool_result` events carry output in `result`, not `content`. */
  result?: string;
  /** `tool_use_start` events carry a JSON object with tool arguments. */
  input?: Record<string, unknown>;
  toolName?: string;
  isError?: boolean;
  /**
   * Tool-use block ID for client-side correlation. Present on
   * `tool_use_start` and `tool_result` envelopes; used to pair a result
   * with its originating call when a subagent emits parallel calls to
   * the same tool (e.g. two `bash` calls) which `toolName` alone cannot
   * disambiguate.
   */
  toolUseId?: string;
}
