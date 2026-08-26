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
   * Conversation the failure happened in.
   *
   * The prompt deliberately outlives a conversation switch (`resetAll` carries
   * it over), so without this a transcript that does not hold the anchor is
   * ambiguous: it could be a different conversation, or the right one with the
   * anchor paged out of the loaded window. History opens at the latest 50
   * messages, so a long background run's spawn call is genuinely often outside
   * it. Naming the owner separates the two, which is what lets the paged-out
   * case dock without the card leaking into an unrelated chat.
   */
  conversationId?: string | null;
}

// ---------------------------------------------------------------------------
// Subagent event types — canonical types now live in
// `@vellumai/assistant-api` (see `subagent-event.ts` /
// `subagent-status-changed.ts`). Re-imported by consumers from
// that package directly.
