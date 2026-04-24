/**
 * Assistant-side gateway delivery client.
 *
 * Delegates transport logic to `@vellumai/gateway-client/http-delivery`
 * while preserving the exported function signatures used by runtime routes
 * and notifications. The assistant's pino logger is injected at call sites
 * so the package stays transport-focused.
 *
 * Channels that support direct delivery (bypassing the gateway HTTP proxy)
 * are handled by `messaging/providers/index.ts`.  This file consults
 * `isDirectDelivery()` before falling through to the HTTP path.
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
  deliverDirect,
  isDirectDelivery,
} from "../messaging/providers/index.js";
import { getLogger } from "../util/logger.js";
import type { ApprovalUIMetadata } from "./channel-approval-types.js";

const log = getLogger("gateway-client");

// Re-export the error class and types so existing import sites are unchanged.
export { ChannelDeliveryError };
export type { ChannelDeliveryResult, ChannelReplyPayload };

export async function deliverChannelReply(
  callbackUrl: string,
  payload: ChannelReplyPayload,
  bearerToken?: string,
): Promise<ChannelDeliveryResult> {
  if (isDirectDelivery(callbackUrl)) {
    return deliverDirect(callbackUrl, payload);
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
  if (isDirectDelivery(callbackUrl)) {
    return deliverDirect(callbackUrl, { chatId, text, approval, assistantId });
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
