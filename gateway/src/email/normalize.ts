import type { GatewayInboundEvent } from "../types.js";

/**
 * Shape of the AgentMail `message.received` webhook event.
 *
 * AgentMail sends a Svix-wrapped payload. The top-level fields are the
 * Svix envelope; the event-specific data is nested under the payload.
 * We only care about `message.received` events for inbound routing.
 */
interface AgentMailMessage {
  inboxId: string;
  threadId: string;
  messageId: string;
  from: string;
  to: string[];
  cc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  extractedText?: string;
  extractedHtml?: string;
  timestamp?: string;
  createdAt?: string;
  attachments?: Array<{
    attachmentId: string;
    filename?: string;
    contentType?: string;
    size?: number;
  }>;
}

export interface NormalizedEmailEvent {
  event: GatewayInboundEvent;
  /** AgentMail event ID for dedup. */
  eventId: string;
  /** Original recipient address for routing. */
  recipientAddress: string;
}

/**
 * Normalize an AgentMail webhook payload into a GatewayInboundEvent.
 *
 * Returns null if the event is not a `message.received` event or if
 * required fields are missing.
 */
export function normalizeEmailWebhook(
  payload: Record<string, unknown>,
): NormalizedEmailEvent | null {
  const eventType = payload.eventType as string | undefined;
  if (eventType !== "message.received") {
    return null;
  }

  const message = payload.message as AgentMailMessage | undefined;
  if (!message) return null;

  const eventId = (payload.eventId as string) ?? message.messageId;
  if (!eventId || !message.messageId) return null;

  const from = message.from;
  if (!from) return null;

  // Use extractedText (new content only, excluding quoted replies) when
  // available, falling back to full text, then HTML-stripped text.
  const content = message.extractedText ?? message.text ?? "";

  // The first recipient in the "to" field is the primary recipient.
  // This is the inbox address used for routing to the correct assistant.
  const recipientAddress = message.to?.[0] ?? "";

  // Extract sender identity from the "from" field.
  // AgentMail sends "Display Name <email@example.com>" or just "email@example.com"
  const senderParsed = parseEmailAddress(from);

  // Use thread ID as conversation ID for thread continuity
  const conversationExternalId = message.threadId;
  const actorExternalId = senderParsed.email;

  const event: GatewayInboundEvent = {
    version: "v1",
    sourceChannel: "email",
    receivedAt: new Date().toISOString(),
    message: {
      content,
      conversationExternalId,
      externalMessageId: message.messageId,
      // Attachments are deferred to PR 5 — not included here
    },
    actor: {
      actorExternalId,
      displayName: senderParsed.displayName || senderParsed.email,
      username: senderParsed.email,
    },
    source: {
      updateId: eventId,
    },
    raw: payload,
  };

  return {
    event,
    eventId,
    recipientAddress,
  };
}

/**
 * Parse an email address string that may include a display name.
 * Handles "Display Name <email@example.com>" and "email@example.com".
 */
function parseEmailAddress(raw: string): {
  email: string;
  displayName?: string;
} {
  const angleMatch = raw.match(/^(.+?)\s*<([^>]+)>$/);
  if (angleMatch) {
    return {
      displayName: angleMatch[1].replace(/^["']|["']$/g, "").trim(),
      email: angleMatch[2].trim(),
    };
  }
  return { email: raw.trim() };
}
