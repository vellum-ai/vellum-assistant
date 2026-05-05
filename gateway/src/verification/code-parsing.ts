/**
 * Verification code parsing for gateway-owned text-channel verification.
 *
 * Mirrors the assistant's parseGuardianVerifyCode from acl-enforcement.ts.
 * Accepts a bare code as the entire message: 6-digit numeric OR 64-char hex.
 * Strips surrounding mrkdwn formatting characters first so that codes
 * pasted with bold/italic/code formatting are still recognized.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Strip Slack/Telegram mrkdwn formatting wrappers from raw message text.
 */
function stripMrkdwnFormatting(text: string): string {
  return text.replace(/^[*_~`]+/, "").replace(/[*_~`]+$/, "");
}

/**
 * Parse a verification code from message content.
 *
 * Returns the code string if the message is a bare 6-digit numeric or
 * 64-char hex code, or undefined if the message is not a verification code.
 */
export function parseVerificationCode(content: string): string | undefined {
  const stripped = stripMrkdwnFormatting(content.trim());
  const match = stripped.match(/^([0-9a-fA-F]{64}|\d{6})$/);
  return match?.[1];
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Hash a verification secret using SHA-256 (matches the assistant's scheme).
 */
export function hashVerificationSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}
