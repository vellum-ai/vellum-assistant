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
  /** Human-readable preview of the command being approved (e.g. shell command). */
  commandPreview?: string;
  /** Risk level label for the request (e.g. 'low', 'medium', 'high'). */
  riskLevel?: string;
  /** Short activity description for richer prompt display. */
  activityText?: string;
  /** Where the tool will execute — sandbox or host. */
  executionTarget?: "sandbox" | "host";
}

export interface GuardianDecisionAction {
  /** Canonical action identifier. */
  action: string;
  /** Human-readable label for the action. */
  label: string;
  /** Short explanation shown in rich-UI legends (Telegram, Slack). */
  description?: string;
}

// ---------------------------------------------------------------------------
// Shared decision action constants
// ---------------------------------------------------------------------------

/** Canonical set of all guardian decision actions with their labels. */
export const GUARDIAN_DECISION_ACTIONS = {
  approve_once: {
    action: "approve_once",
    label: "Approve once",
    description: "This tool, this call only",
  },
  reject: { action: "reject", label: "Reject", description: "Deny this call" },
} as const satisfies Record<string, GuardianDecisionAction>;

export function buildOneTimeDecisionActions(): GuardianDecisionAction[] {
  return [
    GUARDIAN_DECISION_ACTIONS.approve_once,
    GUARDIAN_DECISION_ACTIONS.reject,
  ];
}

/**
 * Build a compact legend string explaining each action, for rich-UI channels
 * (Telegram, Slack) where buttons are shown but their scope isn't obvious.
 *
 * Accepts either `GuardianDecisionAction[]` or action ID strings and looks up
 * descriptions from the canonical constants.
 */
export function buildActionLegend(
  actionIds: readonly (string | { action?: string; id?: string })[],
): string {
  const lookup = GUARDIAN_DECISION_ACTIONS as Record<
    string,
    GuardianDecisionAction | undefined
  >;
  const lines = actionIds
    .map((a) => {
      const id = typeof a === "string" ? a : (a.action ?? a.id ?? "");
      const canonical = lookup[id];
      return canonical?.description
        ? `• *${canonical.label}* — ${canonical.description}`
        : null;
    })
    .filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : "";
}

/**
 * Build the plain-text fallback instruction string for an approval prompt.
 * Always returns the simple "yes/no" form since only approve_once and reject
 * are valid actions.
 */
export function buildPlainTextFallback(
  promptText: string,
  _actions: GuardianDecisionAction[],
): string {
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
