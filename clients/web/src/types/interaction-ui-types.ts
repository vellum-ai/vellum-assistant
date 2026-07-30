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
  /** When "merge", this is a merge-confirmation prompt, not an address entry. */
  mode?: "merge";
  /** Contact id to keep (surviving). Merge mode only. */
  keepId?: string;
  /** Contact id to merge away. Merge mode only. */
  discardId?: string;
  /** Display name of the contact to keep. Merge mode only. */
  keepName?: string;
  /** Display name of the contact to discard. Merge mode only. */
  discardName?: string;
}
  mode?: "merge";
  /** Contact id to keep (surviving). Merge mode only. */
  keepId?: string;
  /** Contact id to merge away. Merge mode only. */
  discardId?: string;
  /** Display name of the contact to keep. Merge mode only. */
  keepName?: string;
  /** Display name of the contact to discard. Merge mode only. */
  discardName?: string;
}

export interface PendingQuestionState {
  requestId: string;
  entries: QuestionEntry[];
  toolUseId?: string;
}

export interface PendingAcpConnectState {
  /** The failed `acp_spawn` tool call this Connect prompt is anchored to, so
   *  the inline affordance renders under the right activity group. */
  toolUseId: string;
}

// ---------------------------------------------------------------------------
// Subagent event types — canonical types now live in
// `@vellumai/assistant-api` (see `subagent-event.ts` /
// `subagent-status-changed.ts`). Re-imported by consumers from
// that package directly.
