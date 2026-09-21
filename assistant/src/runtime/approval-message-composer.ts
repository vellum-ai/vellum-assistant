/**
 * Layered approval message composition system.
 *
 * Generates approval prompt text through a priority chain:
 *   1. Generator-produced rewrite of deterministic fallback text (when provided by daemon)
 *   2. Deterministic fallback templates (natural, scenario-specific messages)
 */
import { getLogger } from "../util/logger.js";
import type {
  ApprovalCopyGenerator,
  ApprovalMessageContext,
  ComposeApprovalMessageGenerativeOptions,
} from "./message-composer-types.js";

export type {
  ApprovalMessageContext,
  ApprovalMessageScenario,
  ComposeApprovalMessageGenerativeOptions,
} from "./message-composer-types.js";

const log = getLogger("approval-message-composer");

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Compose an approval message from its deterministic scenario template. */
export function composeApprovalMessage(
  context: ApprovalMessageContext,
): string {
  return getFallbackMessage(context);
}

/** @internal Exported for use by the daemon-injected generator implementation. */
export function includesRequiredKeywords(
  text: string,
  requiredKeywords: string[] | undefined,
): boolean {
  if (!requiredKeywords || requiredKeywords.length === 0) {
    return true;
  }
  return requiredKeywords.every((keyword) => {
    const re = new RegExp(`\\b${RegExp.escape(keyword)}\\b`, "i");
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
  const fallbackText =
    options.fallbackText?.trim() || getFallbackMessage(context);

  if (process.env.NODE_ENV === "test") {
    return fallbackText;
  }

  if (generator) {
    try {
      const generated = await generator(context, options);
      if (generated) {
        return generated;
      }
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

    case "guardian_identity_mismatch":
      return "This approval request can only be handled by the designated guardian.";

    case "request_pending_guardian":
      return "Your request is pending guardian approval. Please wait for the guardian to respond.";

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

    case "approval_already_resolved":
      return "This approval request has already been resolved.";

    default: {
      // Exhaustive check — TypeScript will flag if a scenario is missing.
      const _exhaustive: never = context.scenario;
      return `Approval required. ${String(_exhaustive)}`;
    }
  }
}
