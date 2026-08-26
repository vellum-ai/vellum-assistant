/**
 * Pure interface types consumed by the interaction state machine and
 * other state-management modules. Framework-agnostic — no routing or
 * SSR dependencies.
 */

export type {
  AllowlistOption,
  DirectoryScopeOption,
  QuestionEntry,
  QuestionOption,
  RiskScopeOption,
  ScopeOption,
} from "@vellumai/assistant-api";

import type {
  AllowlistOption,
  DirectoryScopeOption,
  QuestionEntry,
  ScopeOption,
} from "@vellumai/assistant-api";

// ---------------------------------------------------------------------------
// Chat UI state types — used by interaction store and chat domain
// ---------------------------------------------------------------------------

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
  defaultValue?: string;
  label?: string;
  description?: string;
  role?: string;
}

export interface PendingQuestionState {
  requestId: string;
  entries: QuestionEntry[];
  toolUseId?: string;
}

export interface PendingAcpConnectState {
  /** The `acp_spawn` tool call this Connect prompt is anchored to, so the
   *  inline affordance renders under the right activity group. For a
   *  missing-token failure that is the call that failed; for `auth_required`
   *  the spawn succeeded, so it is the call that started the failed run. */
  toolUseId: string;
  /**
   * Why Connect is being offered. `missing` (default): no token was stored,
   * so the affordance may retire itself once one appears. `auth_required`:
   * the stored token was REJECTED, so presence proves nothing and only
   * completing or dismissing the flow clears the card.
   */
  reason?: "missing" | "auth_required";
  /**
   * Whether this prompt was re-derived from persisted history rather than
   * raised by a live failure in this session.
   *
   * The `auth_required` marker stays in history permanently, so a restored one
   * describes a rejection from some earlier session, which the user may
   * already have repaired. A live one describes a rejection that just
   * happened. Only the restored kind lets the already-connected self-heal
   * retire the card, which is what keeps a stale marker from re-raising it on
   * every cold start after a successful reconnect.
   */
  restoredFromHistory?: boolean;
}

// ---------------------------------------------------------------------------
// Subagent event types — canonical types now live in
// `@vellumai/assistant-api` (see `subagent-event.ts` /
// `subagent-status-changed.ts`). Re-imported by consumers from
// that package directly.
