/**
 * Direct channel delivery — bypasses the gateway HTTP proxy.
 *
 * Each channel that supports direct delivery registers its callback-URL
 * matcher and send logic here.  The gateway-client consults
 * `isDirectDelivery()` before falling back to the HTTP proxy path.
 *
 * Currently supported: WhatsApp.
 * Planned: Telegram, Slack.
 */

import type {
  ChannelDeliveryResult,
  ChannelReplyPayload,
} from "@vellumai/gateway-client";
import { ChannelDeliveryError } from "@vellumai/gateway-client/http-delivery";

import { getLogger } from "../../util/logger.js";
import { sendWhatsAppAttachments, sendWhatsAppReply } from "./whatsapp/send.js";

const log = getLogger("direct-delivery");

// ---------------------------------------------------------------------------
// Callback-URL matchers
// ---------------------------------------------------------------------------

function matchesPathname(callbackUrl: string, pathname: string): boolean {
  try {
    return new URL(callbackUrl).pathname === pathname;
  } catch {
    return callbackUrl.endsWith(pathname);
  }
}

function isWhatsAppCallback(callbackUrl: string): boolean {
  return matchesPathname(callbackUrl, "/deliver/whatsapp");
}

// ---------------------------------------------------------------------------
// Per-channel direct delivery
// ---------------------------------------------------------------------------

async function deliverWhatsApp(
  payload: ChannelReplyPayload,
): Promise<ChannelDeliveryResult> {
  const { chatId, text, attachments, approval } = payload;

  if (text) {
    await sendWhatsAppReply(chatId, text, approval);
  } else if (approval) {
    await sendWhatsAppReply(
      chatId,
      approval.plainTextFallback || "Approval required",
      approval,
    );
  }

  if (attachments && attachments.length > 0) {
    const result = await sendWhatsAppAttachments(chatId, attachments);
    if (result.allFailed && !text) {
      throw new ChannelDeliveryError(
        502,
        `All ${result.failureCount} attachments failed to deliver`,
      );
    }
  }

  log.info({ chatId, hasText: !!text }, "WhatsApp reply delivered (direct)");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true when the given callback URL targets a channel whose
 * outbound delivery is handled directly by the assistant (no gateway hop).
 */
export function isDirectDelivery(callbackUrl: string): boolean {
  return isWhatsAppCallback(callbackUrl);
}

/**
 * Deliver a channel reply directly to the provider API, bypassing the
 * gateway HTTP proxy.  Callers MUST check `isDirectDelivery()` first.
 */
export async function deliverDirect(
  callbackUrl: string,
  payload: ChannelReplyPayload,
): Promise<ChannelDeliveryResult> {
  if (isWhatsAppCallback(callbackUrl)) {
    return deliverWhatsApp(payload);
  }

  // Defensive — isDirectDelivery should have returned false.
  throw new Error(
    `deliverDirect called for unsupported callback: ${callbackUrl}`,
  );
}
