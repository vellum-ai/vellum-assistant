/**
 * Layered approval message composition system.
 *
 * Generates approval prompt text through a priority chain:
 *   1. Assistant preface (macOS parity — reuse existing assistant text)
 *   2. Generator-produced rewrite of deterministic fallback text (when provided by daemon)
 *   3. Deterministic fallback templates (natural, scenario-specific messages)
 */
import { getLogger } from "../util/logger.js";
import type { ApprovalCopyGenerator } from "./http-types.js";

const log = getLogger("approval-message-composer");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApprovalMessageScenario =
  | "standard_prompt"
  | "guardian_prompt"
  | "reminder_prompt"
  | "guardian_delivery_failed"
  | "guardian_request_forwarded"
  | "guardian_disambiguation"
  | "guardian_identity_mismatch"
  | "request_pending_guardian"
  | "guardian_decision_outcome"
  | "guardian_expired_requester"
  | "guardian_expired_guardian"
  | "guardian_verify_success"
  | "guardian_verify_failed"
  | "guardian_verify_challenge_setup"
  | "guardian_verify_status_bound"
  | "guardian_verify_status_unbound"
  | "guardian_deny_no_identity"
  | "guardian_deny_no_binding"
  | "requester_cancel"
  | "approval_already_resolved";

export interface ApprovalMessageContext {
  scenario: ApprovalMessageScenario;
  channel?: string;
  toolName?: string;
  requesterIdentifier?: string;
  guardianIdentifier?: string;
  pendingCount?: number;
  decision?: "approved" | "denied";
  richUi?: boolean;
  /** Pre-existing assistant text to reuse (macOS parity). */
  assistantPreface?: string;
  verifyCommand?: string;
  ttlSeconds?: number;
  failureReason?: string;
}

export interface ComposeApprovalMessageGenerativeOptions {
  /**
   * Optional fallback message to use when generation fails. If omitted,
   * the deterministic scenario fallback is used.
   */
  fallbackText?: string;
  /**
   * Require these standalone words in the generated output (case-insensitive).
   * Useful for plain-text decision flows where parser-compatible keywords
   * like yes/no/always must be present.
   */
  requiredKeywords?: string[];
  timeoutMs?: number;
  maxTokens?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compose an approval message using layered source selection:
 *   1. If an assistant preface is provided and non-empty, return it directly.
 *   2. Otherwise fall back to a deterministic scenario-specific template.
 */
export function composeApprovalMessage(
  context: ApprovalMessageContext,
): string {
  if (context.assistantPreface && context.assistantPreface.trim().length > 0) {
    return context.assistantPreface;
  }

  return getFallbackMessage(context);
}

/** @internal Exported for use by the daemon-injected generator implementation. */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** @internal Exported for use by the daemon-injected generator implementation. */
export function includesRequiredKeywords(
  text: string,
  requiredKeywords: string[] | undefined,
): boolean {
  if (!requiredKeywords || requiredKeywords.length === 0) return true;
  return requiredKeywords.every((keyword) => {
    const re = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "i");
    return re.test(text);
  });
}

/** @internal Exported for use by the daemon-injected generator implementation. */
export function buildGenerationPrompt(
  context: ApprovalMessageContext,
  fallbackText: string,
  requiredKeywords: string[] | undefined,
): string {
  const keywordClause =
    requiredKeywords && requiredKeywords.length > 0
      ? `Required words to include (as standalone words): ${requiredKeywords.join(
          ", ",
        )}.\n`
      : "";
  return [
    "Rewrite the following approval/guardian message as a natural assistant reply to the user.",
    "Keep the same concrete facts and next-step guidance.",
    keywordClause,
    `Context JSON: ${JSON.stringify(context)}`,
    `Fallback message: ${fallbackText}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Constants for the generator implementation (moved to exports for daemon lifecycle). */
export const APPROVAL_COPY_TIMEOUT_MS = 4_000;
export const APPROVAL_COPY_MAX_TOKENS = 180;
export const APPROVAL_COPY_SYSTEM_PROMPT =
  "You are an assistant writing one user-facing message about permissions/approval state. " +
  "Keep it concise, natural, and actionable. Preserve factual details exactly. " +
  "Do not mention internal systems, scenario IDs, or policy engine details. " +
  "Return plain text only.";

/**
 * Compose user-facing approval copy using the daemon-injected generator when
 * available, with deterministic fallback for reliability.
 *
 * The generator parameter is the daemon-provided function that knows about
 * providers. When absent (or in test env), only the deterministic fallback
 * is used.
 */
export async function composeApprovalMessageGenerative(
  context: ApprovalMessageContext,
  options: ComposeApprovalMessageGenerativeOptions = {},
  generator?: ApprovalCopyGenerator,
): Promise<string> {
  if (context.assistantPreface && context.assistantPreface.trim().length > 0) {
    return context.assistantPreface;
  }

  const fallbackText =
    options.fallbackText?.trim() || getFallbackMessage(context);

  if (process.env.NODE_ENV === "test") {
    return fallbackText;
  }

  if (generator) {
    try {
      const generated = await generator(context, options);
      if (generated) return generated;
    } catch (err) {
      log.warn(
        { err, scenario: context.scenario },
        "Failed to generate approval copy, using fallback",
      );
    }
  }

  return fallbackText;
}

// ---------------------------------------------------------------------------
// Deterministic fallback templates
// ---------------------------------------------------------------------------

/**
 * Return a scenario-specific deterministic fallback message.
 *
 * Each template is slightly more conversational than the old hard-coded
 * strings while preserving all required semantic content (tool name,
 * who must approve, next action, etc.).
 */
export function getFallbackMessage(context: ApprovalMessageContext): string {
  switch (context.scenario) {
    case "standard_prompt":
      return `I'd like to use the tool "${
        context.toolName ?? "unknown"
      }". Would you like to allow this?`;

    case "guardian_prompt":
      return `${
        context.requesterIdentifier ?? "A user"
      } is requesting to use "${
        context.toolName ?? "unknown"
      }". Please approve or deny this request.`;

    case "reminder_prompt":
      return "There is a pending approval request. Ask a follow-up question or say approve/deny when you are ready.";

    case "guardian_delivery_failed":
      return context.toolName
        ? `Your request to run "${context.toolName}" could not be sent to the guardian for approval. The request has been denied for safety.`
        : "I wasn't able to reach the guardian to request approval. The request has been denied for safety.";

    case "guardian_request_forwarded":
      return `Your request to use "${
        context.toolName ?? "unknown"
      }" has been forwarded to the guardian for approval. I'll let you know once they decide.`;

    case "guardian_disambiguation":
      return `There are ${
        context.pendingCount ?? "multiple"
      } pending approval requests. Please use the approval buttons to specify which request you're responding to.`;

    case "guardian_identity_mismatch":
      return "This approval request can only be handled by the designated guardian.";

    case "request_pending_guardian":
      return "Your request is pending guardian approval. Please wait for the guardian to respond.";

    case "guardian_decision_outcome":
      return `The guardian has ${
        context.decision ?? "decided on"
      } your request to use "${context.toolName ?? "unknown"}".`;

    case "guardian_expired_requester":
      return `The approval request for "${
        context.toolName ?? "unknown"
      }" has expired without a guardian response. The request has been denied.`;

    case "guardian_expired_guardian":
      return `The approval request from ${
        context.requesterIdentifier ?? "the requester"
      } for "${context.toolName ?? "unknown"}" has expired.`;

    case "guardian_verify_success":
      return "Guardian verification successful! You are now set as the guardian for this channel.";

    case "guardian_verify_failed":
      return `Verification failed. ${
        context.failureReason ?? "Please try again."
      }`;

    case "guardian_verify_challenge_setup": {
      // The instruction must include the code so the macOS client (and other
      // consumers) can parse it from the instruction text.  The
      // "<N>-digit code: <code>" format is shared across channels for
      // consistency; wording adapts to channel and code type.
      const code = context.verifyCommand ?? "the verification code";
      // Detect whether the code is a short numeric (identity-bound outbound)
      // or a high-entropy hex (inbound challenge/bootstrap) and adjust wording.
      const isNumeric = /^\d{4,8}$/.test(code);
      if (context.channel === "phone") {
        if (isNumeric) {
          return `To complete guardian verification, speak or enter the ${code.length}-digit code: ${code}.`;
        }
        return `To complete guardian verification, enter the code: ${code}.`;
      }
      if (isNumeric) {
        return `To complete guardian verification, send the ${code.length}-digit code: ${code}.`;
      }
      return `To complete guardian verification, send the code: ${code}.`;
    }

    case "guardian_verify_status_bound":
      return "A guardian is currently active for this channel.";

    case "guardian_verify_status_unbound":
      return "No guardian is currently configured for this channel.";

    case "guardian_deny_no_identity":
      return "This action requires approval, but your identity could not be verified. The request has been denied for safety.";

    case "guardian_deny_no_binding":
      return "This action requires guardian approval, but no guardian has been configured for this channel. The request has been denied for safety.";

    case "requester_cancel":
      return context.toolName
        ? `Your request to use "${context.toolName}" has been cancelled.`
        : "Your pending request has been cancelled.";

    case "approval_already_resolved":
      return "This approval request has already been resolved.";

    default: {
      // Exhaustive check — TypeScript will flag if a scenario is missing.
      const _exhaustive: never = context.scenario;
      return `Approval required. ${String(_exhaustive)}`;
    }
  }
}
