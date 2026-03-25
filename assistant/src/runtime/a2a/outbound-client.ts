/**
 * Daemon-internal A2A outbound sender.
 *
 * Delivers messages to remote assistants via the local gateway's
 * `/deliver/a2a` endpoint using standard `ChannelReplyPayload`.
 * The gateway handles all A2A envelope construction and outbound
 * credential resolution — the daemon never constructs A2A-specific
 * payloads directly.
 */

import { getGatewayInternalBaseUrl } from "../../config/env.js";
import {
  getAssistantContactMetadata,
  getContact,
} from "../../contacts/contact-store.js";
import { getLogger } from "../../util/logger.js";
import { mintEdgeRelayToken } from "../auth/token-service.js";
import {
  ChannelDeliveryError,
  deliverChannelReply,
} from "../gateway-client.js";

const log = getLogger("a2a-outbound");

export interface A2ASendResult {
  ok: boolean;
  error?: string;
}

/**
 * Send an A2A message to a target assistant contact.
 *
 * Resolution flow:
 *   1. Look up the contact by ID.
 *   2. Verify it is a `contactType: "assistant"` contact.
 *   3. Retrieve assistant metadata (species must be "vellum") with
 *      `assistantId` and `gatewayUrl`.
 *   4. Construct callback URL pointing to gateway `/deliver/a2a` with
 *      target routing context as query params.
 *   5. Deliver via `deliverChannelReply()` using standard `ChannelReplyPayload`.
 *
 * Fails closed when contact metadata is missing or contact type is wrong.
 */
export async function sendA2AMessage(
  targetContactId: string,
  content: string,
): Promise<A2ASendResult> {
  // 1. Resolve contact
  const contact = getContact(targetContactId);
  if (!contact) {
    log.warn({ targetContactId }, "A2A send failed: contact not found");
    return { ok: false, error: `Contact not found: ${targetContactId}` };
  }

  // 2. Verify contact type
  if (contact.contactType !== "assistant") {
    log.warn(
      { targetContactId, contactType: contact.contactType },
      "A2A send failed: contact is not an assistant",
    );
    return {
      ok: false,
      error: `Contact "${contact.displayName}" is not an assistant (type: ${contact.contactType})`,
    };
  }

  // 3. Retrieve assistant metadata
  const metadata = getAssistantContactMetadata(targetContactId);
  if (!metadata) {
    log.warn(
      { targetContactId },
      "A2A send failed: no assistant metadata found",
    );
    return {
      ok: false,
      error: `No assistant metadata found for contact "${contact.displayName}"`,
    };
  }

  if (metadata.species !== "vellum" || !metadata.metadata) {
    log.warn(
      { targetContactId, species: metadata.species },
      "A2A send failed: unsupported assistant species or missing metadata",
    );
    return {
      ok: false,
      error: `Contact "${contact.displayName}" does not have valid Vellum assistant metadata`,
    };
  }

  const { assistantId: targetAssistantId, gatewayUrl: targetGatewayUrl } =
    metadata.metadata;

  // 4. Construct callback URL pointing to local gateway /deliver/a2a
  const gatewayBaseUrl = getGatewayInternalBaseUrl();
  const callbackUrl =
    `${gatewayBaseUrl}/deliver/a2a` +
    `?gatewayUrl=${encodeURIComponent(targetGatewayUrl)}` +
    `&assistantId=${encodeURIComponent(targetAssistantId)}`;

  // 5. Deliver via standard ChannelReplyPayload
  const bearerToken = mintEdgeRelayToken();

  try {
    await deliverChannelReply(
      callbackUrl,
      { chatId: targetAssistantId, text: content },
      bearerToken,
    );

    log.info(
      {
        targetContactId,
        targetAssistantId,
        displayName: contact.displayName,
      },
      "A2A message sent successfully",
    );

    return { ok: true };
  } catch (err) {
    const message =
      err instanceof ChannelDeliveryError
        ? `Delivery failed (${err.statusCode}): ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);

    log.error(
      {
        targetContactId,
        targetAssistantId,
        error: message,
      },
      "A2A send failed: delivery error",
    );

    return { ok: false, error: message };
  }
}
