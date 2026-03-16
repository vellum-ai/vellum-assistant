/**
 * Deterministic call pointer message templates and instruction builder.
 *
 * Provides fallback templates for untrusted audiences and builds
 * structured instructions for the daemon conversation to generate pointer
 * copy as a natural conversation turn for trusted audiences.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CallPointerMessageScenario =
  | "started"
  | "completed"
  | "failed"
  | "verification_succeeded"
  | "verification_failed";

export interface CallPointerMessageContext {
  scenario: CallPointerMessageScenario;
  phoneNumber: string;
  duration?: string;
  reason?: string;
  verificationCode?: string;
  channel?: string;
}

// ---------------------------------------------------------------------------
// Daemon instruction builder
// ---------------------------------------------------------------------------

/**
 * Build an instruction message to send to the daemon conversation so the
 * assistant generates a natural pointer status update as a conversation turn.
 */
export function buildPointerInstruction(
  context: CallPointerMessageContext,
): string {
  const parts: string[] = [
    "[CALL_STATUS_EVENT]",
    `Event: ${context.scenario}`,
    `Phone number: ${context.phoneNumber}`,
  ];
  if (context.duration) parts.push(`Duration: ${context.duration}`);
  if (context.reason) parts.push(`Reason: ${context.reason}`);
  if (context.verificationCode)
    parts.push(`Verification code: ${context.verificationCode}`);
  if (context.channel) parts.push(`Channel: ${context.channel}`);

  parts.push("");
  parts.push(
    "Write a brief (1-2 sentence) status update about this phone call event for the user. " +
      "Preserve all factual details exactly (phone numbers, durations, failure reasons, verification codes). " +
      "Be concise, natural, and informative.",
  );

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Deterministic fallback templates
// ---------------------------------------------------------------------------

/**
 * Return a scenario-specific deterministic fallback message.
 *
 * Used for untrusted audiences and when the daemon processor is unavailable.
 */
export function getPointerFallbackMessage(
  context: CallPointerMessageContext,
): string {
  switch (context.scenario) {
    case "started":
      return context.verificationCode
        ? `\u{1F4DE} Call to ${context.phoneNumber} started. Verification code: ${context.verificationCode}`
        : `\u{1F4DE} Call to ${context.phoneNumber} started.`;
    case "completed":
      return context.duration
        ? `\u{1F4DE} Call to ${context.phoneNumber} completed (${context.duration}).`
        : `\u{1F4DE} Call to ${context.phoneNumber} completed.`;
    case "failed":
      return context.reason
        ? `\u{1F4DE} Call to ${context.phoneNumber} failed: ${context.reason}.`
        : `\u{1F4DE} Call to ${context.phoneNumber} failed.`;
    case "verification_succeeded": {
      const ch = context.channel ?? "phone";
      return `\u{2705} Guardian verification (${ch}) for ${context.phoneNumber} succeeded.`;
    }
    case "verification_failed": {
      const ch = context.channel ?? "phone";
      return context.reason
        ? `\u{274C} Guardian verification (${ch}) for ${context.phoneNumber} failed: ${context.reason}.`
        : `\u{274C} Guardian verification (${ch}) for ${context.phoneNumber} failed.`;
    }
    default: {
      const _exhaustive: never = context.scenario;
      return `Call status update. ${String(_exhaustive)}`;
    }
  }
}
