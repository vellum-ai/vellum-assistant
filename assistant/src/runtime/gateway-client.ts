/**
 * Assistant-side gateway delivery client.
 *
 * Delegates transport logic to `@vellumai/gateway-client/http-delivery`
 * while preserving the exported function signatures used by runtime routes
 * and notifications. The assistant's pino logger is injected at call sites
 * so the package stays transport-focused.
 *
 * WhatsApp delivery is intercepted here and handled locally via the Meta
 * Cloud API (see messaging/providers/whatsapp/) instead of proxying through
 * the gateway HTTP endpoint.
 */

import type {
  ChannelDeliveryResult,
  ChannelReplyPayload,
} from "@vellumai/gateway-client";
import {
  ChannelDeliveryError,
  deliverApprovalPrompt as _deliverApprovalPrompt,
  deliverChannelReply as _deliverChannelReply,
} from "@vellumai/gateway-client/http-delivery";

import {
  sendWhatsAppAttachments,
  sendWhatsAppReply,
} from "../messaging/providers/whatsapp/send.js";
import { getLogger } from "../util/logger.js";
import type { ApprovalUIMetadata } from "./channel-approval-types.js";

const log = getLogger("gateway-client");

// Re-export the error class and types so existing import sites are unchanged.
export { ChannelDeliveryError };
export type { ChannelDeliveryResult, ChannelReplyPayload };

// ---------------------------------------------------------------------------
// WhatsApp direct delivery (bypasses gateway HTTP)
// ---------------------------------------------------------------------------

function isWhatsAppCallback(callbackUrl: string): boolean {
  try {
    return new URL(callbackUrl).pathname === "/deliver/whatsapp";
  } catch {
    return callbackUrl.endsWith("/deliver/whatsapp");
  }
}

async function deliverWhatsAppDirect(
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

export async function deliverChannelReply(
  callbackUrl: string,
  payload: ChannelReplyPayload,
  bearerToken?: string,
): Promise<ChannelDeliveryResult> {
  if (isWhatsAppCallback(callbackUrl)) {
    return deliverWhatsAppDirect(payload);
  }
  return _deliverChannelReply(callbackUrl, payload, bearerToken, log);
}

/**
 * Deliver an approval prompt (text + inline keyboard metadata) to the
 * gateway so it can render the approval UI in the channel.
 */
export async function deliverApprovalPrompt(
  callbackUrl: string,
  chatId: string,
  text: string,
  approval: ApprovalUIMetadata,
  assistantId?: string,
  bearerToken?: string,
): Promise<ChannelDeliveryResult> {
  if (isWhatsAppCallback(callbackUrl)) {
    return deliverWhatsAppDirect({ chatId, text, approval, assistantId });
  }
  return _deliverApprovalPrompt(
    callbackUrl,
    chatId,
    text,
    approval,
    assistantId,
    bearerToken,
    log,
  );
}
