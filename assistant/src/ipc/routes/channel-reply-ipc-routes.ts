/**
 * IPC-only channel reply method called by the gateway over the assistant IPC
 * socket (`ipcCallAssistant`).
 *
 * The gateway answers some inbound messages itself without forwarding them
 * (a verification code, an invite redemption), so the assistant never sees
 * them. Its reply still has to reach the person, and the channel transports
 * that can send it live here. This hands the reply to the transport the
 * inbound message's callback URL names, which is how the daemon's own
 * intercepts answer an inbound message: the gateway sends through the same
 * transports and never to a provider itself.
 *
 * Nothing is recorded in a conversation. The message the reply answers never
 * entered one, so a row for the reply would stand alone in a transcript that
 * does not hold what it responds to.
 */

import {
  DELIVER_GATEWAY_REPLY_IPC_METHOD,
  GatewayReplyRequestSchema,
} from "@vellumai/gateway-client";

import {
  deliverDirect,
  isDirectDelivery,
} from "../../messaging/providers/index.js";
import {
  BadGatewayError,
  BadRequestError,
} from "../../runtime/routes/errors.js";
import { parseBody } from "../../runtime/routes/parse-body.js";
import type { RouteHandlerArgs } from "../../runtime/routes/types.js";

/**
 * Deliver a gateway-composed reply through the channel transport its callback
 * URL names. Refuses a callback no transport owns rather than fetching it, so
 * the gateway learns the channel cannot be answered this way.
 *
 * A send the channel refuses is answered as a `BadGatewayError`, as
 * `channels/send` answers it: only a `RouteError` carries a status over IPC,
 * and the gateway reads an error without one as a daemon that never answered.
 */
export async function handleDeliverGatewayReply({
  body = {},
}: RouteHandlerArgs) {
  const { callbackUrl, chatId, text, assistantId } = parseBody(
    GatewayReplyRequestSchema,
    body,
  );
  if (!isDirectDelivery(callbackUrl)) {
    throw new BadRequestError("No channel transport owns this callback URL");
  }
  try {
    return await deliverDirect(callbackUrl, {
      chatId,
      text,
      ...(assistantId ? { assistantId } : {}),
    });
  } catch (err) {
    throw new BadGatewayError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * IPC-only channel reply methods, keyed by IPC operationId. Registered
 * directly on the assistant IPC server (see `assistant-server.ts`).
 */
export const CHANNEL_REPLY_IPC_METHODS: Record<
  string,
  (args: RouteHandlerArgs) => unknown
> = {
  [DELIVER_GATEWAY_REPLY_IPC_METHOD]: handleDeliverGatewayReply,
};
