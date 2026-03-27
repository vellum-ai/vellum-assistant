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
  approve_10m: {
    action: "approve_10m",
    label: "Allow 10 min",
    description: "All tools for 10 minutes",
  },
  approve_conversation: {
    action: "approve_conversation",
    label: "Allow conversation",
    description: "All tools for this conversation",
  },
  approve_always: {
    action: "approve_always",
    label: "Approve always",
    description: "This tool, permanently",
  },
  reject: { action: "reject", label: "Reject", description: "Deny this call" },
} as const satisfies Record<string, GuardianDecisionAction>;

/**
 * Build the set of `GuardianDecisionAction` items appropriate for a prompt,
 * respecting whether persistent decisions (approve_always) are allowed.
 *
 * When `persistentDecisionsAllowed` is `false`, the `approve_always` action
 * and temporary modes are excluded. When `forGuardianOnBehalf` is `true`
 * (guardian acting on behalf of a requester), only `approve_always` is excluded
 * — temporary modes (`approve_10m`, `approve_conversation`) are permitted
 * because grants are scoped to the tool+input signature via scopeMode:
 * "tool_signature".
 */
export function buildDecisionActions(opts?: {
  persistentDecisionsAllowed?: boolean;
  forGuardianOnBehalf?: boolean;
}): GuardianDecisionAction[] {
  const showAlways =
    opts?.persistentDecisionsAllowed !== false && !opts?.forGuardianOnBehalf;
  const showTemporary = opts?.persistentDecisionsAllowed !== false;
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
