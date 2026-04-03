import type { GatewayInboundEvent } from "../types.js";

/**
 * Shape of a normalized inbound email event as sent by the Vellum
 * platform (or any upstream caller).
 *
 * The platform is responsible for provider-specific parsing (e.g.
 * Mailgun multipart → JSON). By the time the payload reaches the
 * gateway it should already be in this canonical shape.
 */
export interface VellumEmailPayload {
  /** Sender email address (e.g. "user@vellum.me"). */
  from: string;
  /** Sender display name (e.g. "Alice Smith"). Optional. */
  fromName?: string;
  /** Recipient email address (the assistant's address). */
  to: string;
  /** Email subject line. */
  subject?: string;
  /** Plain-text body content (latest reply only, quoted text stripped). */
  strippedText?: string;
  /** Full plain-text body (fallback when strippedText is unavailable). */
  bodyText?: string;
  /** RFC 5322 Message-ID header value. */
  messageId: string;
  /** Message-ID of the parent message (In-Reply-To header). */
  inReplyTo?: string;
  /** Space-separated chain of ancestor Message-IDs (References header). */
  references?: string;
  /** Stable conversation/thread identifier derived by the platform. */
  conversationId: string;
  /** ISO 8601 timestamp of the original email. */
  timestamp?: string;
}

export interface NormalizedEmailEvent {
  event: GatewayInboundEvent;
  /** Unique event/message ID for dedup. */
  eventId: string;
  /** Original recipient address for routing. */
  recipientAddress: string;
}

/**
 * Normalize a Vellum email webhook payload into a GatewayInboundEvent.
 *
 * Returns null if required fields are missing.
 */
export function normalizeEmailWebhook(
  payload: Record<string, unknown>,
): NormalizedEmailEvent | null {
  const from = payload.from as string | undefined;
  const to = payload.to as string | undefined;
  const messageId = payload.messageId as string | undefined;
  const conversationId = payload.conversationId as string | undefined;

  if (!from || !to || !messageId || !conversationId) {
    return null;
  }

  // Prefer strippedText (latest reply only) over full body
  const content =
    (payload.strippedText as string | undefined) ??
    (payload.bodyText as string | undefined) ??
    "";

  const fromName = payload.fromName as string | undefined;

  const event: GatewayInboundEvent = {
    version: "v1",
    sourceChannel: "email",
    receivedAt: new Date().toISOString(),
    message: {
      content,
      conversationExternalId: conversationId,
      externalMessageId: messageId,
    },
    actor: {
      actorExternalId: from,
      displayName: fromName || from,
      username: from,
    },
    source: {
      updateId: messageId,
    },
    raw: payload,
  };

  return {
    event,
    eventId: messageId,
    recipientAddress: to,
  };
}
