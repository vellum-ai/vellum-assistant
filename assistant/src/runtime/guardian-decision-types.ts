/**
 * Shared types for the guardian decision primitive.
 *
 * All decision entrypoints (callback buttons, conversational engine, legacy
 * parser, requester self-cancel) use these types to route through the
 * unified `applyGuardianDecision` primitive.
 */

// ---------------------------------------------------------------------------
// Guardian decision prompt
// ---------------------------------------------------------------------------

/** Structured model for prompts shown to guardians. */
export interface GuardianDecisionPrompt {
  requestId: string;
  /** Short human-readable code for the request. */
  requestCode: string;
  state:
    | "pending"
    | "followup_awaiting_choice"
    | "expired_superseded_with_active_call";
  questionText: string;
  toolName: string | null;
  actions: GuardianDecisionAction[];
  expiresAt: number;
  conversationId: string;
  callSessionId: string | null;
  /**
   * Canonical request kind (e.g. 'tool_approval', 'pending_question').
   * Present when the prompt originates from the canonical guardian request
   * store. Absent for legacy-only prompts.
   */
  kind?: string;
}

export interface GuardianDecisionAction {
  /** Canonical action identifier. */
  action: string;
  /** Human-readable label for the action. */
  label: string;
}

// ---------------------------------------------------------------------------
// Shared decision action constants
// ---------------------------------------------------------------------------

/** Canonical set of all guardian decision actions with their labels. */
export const GUARDIAN_DECISION_ACTIONS = {
  approve_once: { action: "approve_once", label: "Approve once" },
  approve_10m: { action: "approve_10m", label: "Allow 10 min" },
  approve_conversation: {
    action: "approve_conversation",
    label: "Allow conversation",
  },
  approve_always: { action: "approve_always", label: "Approve always" },
  reject: { action: "reject", label: "Reject" },
} as const satisfies Record<string, GuardianDecisionAction>;

/**
 * Build the set of `GuardianDecisionAction` items appropriate for a prompt,
 * respecting whether persistent decisions (approve_always) are allowed.
 *
 * When `persistentDecisionsAllowed` is `false`, the `approve_always` action
 * is excluded. When `forGuardianOnBehalf` is `true` (guardian acting on behalf
 * of a requester), both `approve_always` and the temporary modes are excluded
 * since guardians cannot grant broad delegated allow modes on behalf of others.
 *
 * Temporary modes (`approve_10m`, `approve_conversation`) are included for
 * requester-side standard approval flows when persistent decisions are allowed.
 */
export function buildDecisionActions(opts?: {
  persistentDecisionsAllowed?: boolean;
  forGuardianOnBehalf?: boolean;
}): GuardianDecisionAction[] {
  const showAlways =
    opts?.persistentDecisionsAllowed !== false && !opts?.forGuardianOnBehalf;
  const showTemporary =
    opts?.persistentDecisionsAllowed !== false && !opts?.forGuardianOnBehalf;
  return [
    GUARDIAN_DECISION_ACTIONS.approve_once,
    ...(showTemporary
      ? [
          GUARDIAN_DECISION_ACTIONS.approve_10m,
          GUARDIAN_DECISION_ACTIONS.approve_conversation,
        ]
      : []),
    ...(showAlways ? [GUARDIAN_DECISION_ACTIONS.approve_always] : []),
    GUARDIAN_DECISION_ACTIONS.reject,
  ];
}

/**
 * Build the plain-text fallback instruction string that matches the given
 * set of decision actions. Ensures the text always includes parser-compatible
 * keywords so text-based fallback remains actionable.
 */
export function buildPlainTextFallback(
  promptText: string,
  actions: GuardianDecisionAction[],
): string {
  const hasAlways = actions.some((a) => a.action === "approve_always");
  const has10m = actions.some((a) => a.action === "approve_10m");
  const hasConversation = actions.some(
    (a) => a.action === "approve_conversation",
  );

  if (hasAlways && has10m && hasConversation) {
    return `${promptText}\n\nReply "yes" to approve once, "approve for 10 minutes", "approve for conversation", "always" to approve always, or "no" to reject.`;
  }
  if (hasAlways) {
    return `${promptText}\n\nReply "yes" to approve once, "always" to approve always, or "no" to reject.`;
  }
  if (has10m && hasConversation) {
    return `${promptText}\n\nReply "yes" to approve once, "approve for 10 minutes", "approve for conversation", or "no" to reject.`;
  }
  return `${promptText}\n\nReply "yes" to approve or "no" to reject.`;
}

// ---------------------------------------------------------------------------
// Apply decision result
// ---------------------------------------------------------------------------

export interface ApplyGuardianDecisionResult {
  applied: boolean;
  reason?:
    | "stale"
    | "identity_mismatch"
    | "invalid_action"
    | "not_found"
    | "expired";
  requestId?: string;
  /** Feedback text when the action was parsed from user text. */
  userText?: string;
}
