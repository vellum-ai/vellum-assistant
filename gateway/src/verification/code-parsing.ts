/**
 * Verification code parsing for gateway-owned text-channel verification.
 *
 * Mirrors the assistant's parseGuardianVerifyCode from acl-enforcement.ts.
 * Accepts a bare code as the entire message: 6-digit numeric OR 64-char hex.
 * Strips surrounding mrkdwn formatting characters first so that codes
 * pasted with bold/italic/code formatting are still recognized.
 */

// ---------------------------------------------------------------------------
// Email reply stripping
// ---------------------------------------------------------------------------

/**
 * Extract the fresh reply portion of an email body, discarding quoted
 * thread text, signature blocks, and provider-specific reply headers.
 */
export function extractEmailReplyBody(body: string): string {
  const lines = body.split(/\r?\n/);
  const freshLines: string[] = [];

  for (const line of lines) {
    if (/^>/.test(line)) break;
    if (/^On .+ wrote:\s*$/.test(line)) break;
    if (/^-{2,}\s*(Original Message|Forwarded message)/i.test(line)) break;
    if (line === "-- " || line === "--") break;
    if (/^(From|Sent|To|Subject):\s/i.test(line) && freshLines.length > 0)
      break;

    freshLines.push(line);
  }

  return freshLines.join("\n").trim();
}

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

// Single-sourced from the shared contract; re-exported for existing callers.
export { hashVerificationSecret } from "@vellumai/gateway-client";
