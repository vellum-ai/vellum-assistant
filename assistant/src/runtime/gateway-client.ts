/**
 * Assistant-side channel delivery client.
 *
 * Channels with direct delivery support (WhatsApp, Telegram, Slack) are
 * handled by `messaging/providers/index.ts` without touching the gateway.
 *
 * Managed outbound callbacks (platform-routed phone/SMS) are handled by
 * `@vellumai/gateway-client/http-delivery` with retry/idempotency semantics.
 * Those callbacks carry their own `callback_token` in the URL — no daemon
 * bearer token is needed.
 */

import type {
  ChannelDeliveryResult,
  ChannelReplyPayload,
} from "@vellumai/gateway-client";
import {
  ChannelDeliveryError,
  deliverChannelReply as _deliverChannelReply,
} from "@vellumai/gateway-client/http-delivery";

import { ipcCall } from "../ipc/gateway-client.js";
import {
  deliverDirect,
  isDirectDelivery,
} from "../messaging/providers/index.js";
import { getLogger } from "../util/logger.js";
import type { ApprovalUIMetadata } from "./channel-approval-types.js";

const log = getLogger("gateway-client");
const SLACK_ACTIVE_THREAD_IPC_TIMEOUT_MS = 1_000;

// Re-export the error class and types so existing import sites are unchanged.
export { ChannelDeliveryError };
export type { ChannelDeliveryResult, ChannelReplyPayload };

export async function deliverChannelReply(
  callbackUrl: string,
  payload: ChannelReplyPayload,
): Promise<ChannelDeliveryResult> {
  if (isDirectDelivery(callbackUrl)) {
    return deliverDirect(callbackUrl, payload);
  }
  return _deliverChannelReply(callbackUrl, payload, undefined, log);
}

/**
 * Deliver an approval prompt (text + inline keyboard metadata) to the
 * channel via direct provider API calls or managed outbound delivery.
 */
export async function deliverApprovalPrompt(
  callbackUrl: string,
  chatId: string,
  text: string,
  approval: ApprovalUIMetadata,
  assistantId?: string,
): Promise<ChannelDeliveryResult> {
  if (isDirectDelivery(callbackUrl)) {
    return deliverDirect(callbackUrl, { chatId, text, approval, assistantId });
  }
  return _deliverChannelReply(
    callbackUrl,
    { chatId, text, approval, assistantId },
    undefined,
    log,
  );
}

export async function trackSlackActiveThread(
  channelId: string,
  threadTs: string,
  ttlMs?: number,
): Promise<boolean> {
  const result = await ipcCall(
    "track_slack_active_thread",
    { channelId, threadTs, ttlMs },
    SLACK_ACTIVE_THREAD_IPC_TIMEOUT_MS,
  );
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    log.warn(
      { channelId, threadTs, result },
      "Failed to activate Slack thread after successful reply delivery",
    );
    return false;
  }

  return (result as { tracked?: unknown }).tracked === true;
}
