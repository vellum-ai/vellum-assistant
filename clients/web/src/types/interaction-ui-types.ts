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
   * Why Connect is being offered, which decides whether the affordance may
   * self-dismiss once a token is present.
   *
   * - `missing` (default): no token was stored, so a token appearing means the
   *   problem is solved and a stale card should retire itself.
   * - `auth_required`: a token WAS stored and the agent rejected it. Presence
   *   proves nothing here, so the card must not retire on a connected check;
   *   only finishing the flow (or dismissing it) clears it.
   */
  reason?: "missing" | "auth_required";
}

// ---------------------------------------------------------------------------
// Subagent event types — canonical types now live in
// `@vellumai/assistant-api` (see `subagent-event.ts` /
// `subagent-status-changed.ts`). Re-imported by consumers from
// that package directly.
