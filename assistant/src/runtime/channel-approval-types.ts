/**
 * Channel-agnostic approval flow types.
 *
 * These types model the approval prompt/decision lifecycle for tool-use
 * confirmations surfaced through external channels (Telegram, SMS, etc.).
 * They are intentionally decoupled from any specific channel so that the
 * same approval flow can be reused across transports.
 */

// ---------------------------------------------------------------------------
// Approval actions
// ---------------------------------------------------------------------------

/** The set of actions a user can take on an approval prompt. */
export type ApprovalAction = 'approve_once' | 'approve_always' | 'reject';

/** An action presented to the user as a tappable button or text option. */
export interface ApprovalActionOption {
  id: ApprovalAction;
  label: string;
}

/** Default action options presented to users across all channels. */
export const DEFAULT_APPROVAL_ACTIONS: readonly ApprovalActionOption[] = [
  { id: 'approve_once', label: 'Approve once' },
  { id: 'approve_always', label: 'Approve always' },
  { id: 'reject', label: 'Reject' },
] as const;

// ---------------------------------------------------------------------------
// Approval prompt
// ---------------------------------------------------------------------------

/** The approval prompt model sent to users via a channel. */
export interface ChannelApprovalPrompt {
  /** Human-readable description of what is being approved. */
  promptText: string;
  /** Available actions the user can take. */
  actions: ApprovalActionOption[];
  /** Instruction text for channels that only support plain text (no buttons). */
  plainTextFallback: string;
}

// ---------------------------------------------------------------------------
// Approval UI metadata (gateway callback payload)
// ---------------------------------------------------------------------------

/**
 * Metadata attached to gateway callback payloads so the channel adapter
 * can render approval UI and route the user's decision back to the
 * correct pending run.
 */
export interface ApprovalUIMetadata {
  runId: string;
  requestId: string;
  actions: ApprovalActionOption[];
  plainTextFallback: string;
}

// ---------------------------------------------------------------------------
// Decision result
// ---------------------------------------------------------------------------

/** How the user communicated their decision. */
export type ApprovalDecisionSource = 'telegram_button' | 'plain_text';

/** The structured result of a user's approval decision. */
export interface ApprovalDecisionResult {
  action: ApprovalAction;
  source: ApprovalDecisionSource;
  /** Run ID extracted from callback data (button presses only). */
  runId?: string;
}
