/**
 * Verification reply delivery for gateway-owned text-channel verification.
 *
 * Delivers deterministic template-driven replies to the originating channel
 * via the replyCallbackUrl (the gateway's own /deliver/* endpoint). This
 * keeps verification replies entirely within the gateway — the assistant
 * never sees verification code messages.
 */

import { fetchImpl } from "../fetch.js";
import { getLogger } from "../logger.js";

const log = getLogger("verification-reply");

const DELIVERY_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Reply templates (mirrors assistant's verification-templates.ts)
// ---------------------------------------------------------------------------

export function composeVerificationSuccessReply(
  verificationType?: "guardian" | "trusted_contact",
): string {
  if (verificationType === "trusted_contact") {
    return "Verification successful! You can now message the assistant.";
  }
  return "Verification successful. You are now set as the guardian for this channel.";
}

export function composeVerificationFailureReply(
  reason?: string,
): string {
  return reason ?? "The verification code is invalid or has expired.";
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export interface VerificationReplyParams {
  replyCallbackUrl: string;
  chatId: string;
  text: string;
  assistantId?: string;
}

/**
 * Deliver a verification reply via the channel's callback URL.
 *
 * Uses fetchImpl (the gateway's fetch wrapper) to call the gateway's own
 * /deliver/* endpoint. Retries once after a short delay on failure.
 */
export async function deliverVerificationReply(
  params: VerificationReplyParams,
): Promise<void> {
  const { replyCallbackUrl, chatId, text, assistantId } = params;

  const body = JSON.stringify({
    chatId,
    text,
    ...(assistantId ? { assistantId } : {}),
  });

  const headers = { "Content-Type": "application/json" };

  try {
    const res = await fetchImpl(replyCallbackUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });

    if (!res.ok) {
      const resBody = await res.text().catch(() => "<unreadable>");
      log.error(
        { status: res.status, body: resBody, chatId },
        "Verification reply delivery returned non-OK status",
      );
    }
  } catch (err) {
    log.error(
      { err, chatId },
      "Verification reply delivery failed — retrying once",
    );

    // Single retry after 2s
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const retryRes = await fetchImpl(replyCallbackUrl, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (!retryRes.ok) {
        log.error(
          { status: retryRes.status, chatId },
          "Verification reply retry also failed",
        );
      }
    } catch (retryErr) {
      log.error(
        { err: retryErr, chatId },
        "Verification reply retry threw",
      );
    }
  }
}
