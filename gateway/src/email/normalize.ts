import type { GatewayInboundEvent } from "../types.js";

/**
 * A single inbound email attachment, inlined as base64 by the upstream
 * caller (the Vellum platform fetches the blob from the provider's
 * Attachments API and embeds it here, bounded by a per-file / per-message
 * cap). The gateway uploads each attachment to the assistant's attachment
 * store so it lands in the conversation workspace.
 */
export interface EmailAttachment {
  /** Original filename as sent by the email client (e.g. "receipt.pdf"). */
  filename: string;
  /** MIME type declared by the sender (e.g. "application/pdf"). */
  contentType: string;
  /** Decoded byte size, when the upstream caller reports it. */
  size?: number;
  /** Base64-encoded attachment bytes. */
  content: string;
  /** RFC 2392 Content-ID for inline (cid:) references, when present. */
  contentId?: string;
}

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
  /**
   * Whether the platform authenticated the sender's `From:` address against
   * the message's SPF/DKIM/DMARC results. `true` when authentication passed,
   * `false` when it was evaluated and failed (spoofable sender), omitted when
   * the platform could not evaluate (no auth-results header). The gateway
   * downgrades an unauthenticated sender so a forged `From:` cannot inherit
   * guardian/trusted_contact trust.
   */
  senderAuthenticated?: boolean;
  /**
   * Inbound attachments, inlined as base64 by the upstream caller. Additive
   * and optional — payloads without attachments (or from callers that do not
   * fetch them) simply omit the field. The gateway uploads each to the
   * assistant's attachment store and forwards the resulting ids so they land
   * in the conversation workspace.
   */
  attachments?: EmailAttachment[];
}

export interface NormalizedEmailEvent {
  event: GatewayInboundEvent;
  /** Unique event/message ID for dedup. */
  eventId: string;
  /** Original recipient address for routing. */
  recipientAddress: string;
  /**
   * The payload's {@link VellumEmailPayload.senderAuthenticated} signal,
   * forwarded to the trust-verdict downgrade in `handleInbound`. Omitted when
   * the payload carried no boolean value.
   */
  senderAuthenticated?: boolean;
  /**
   * Validated inbound attachments parsed from the payload. Only well-formed
   * entries (string `filename`, `contentType`, and base64 `content`) survive;
   * omitted when the payload carried none.
   */
  attachments?: EmailAttachment[];
}

/**
 * Parse and validate the payload's `attachments` array. Drops entries that
 * are missing the fields the attachment store requires (`filename`,
 * `contentType`, base64 `content`); coerces `size`/`contentId` when present.
 * Returns undefined when there are no usable attachments.
 */
function parseEmailAttachments(raw: unknown): EmailAttachment[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const parsed: EmailAttachment[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const att = entry as Record<string, unknown>;
    const filename = att.filename;
    const contentType = att.contentType;
    const content = att.content;
    if (
      typeof filename !== "string" ||
      filename.length === 0 ||
      typeof contentType !== "string" ||
      contentType.length === 0 ||
      typeof content !== "string"
    ) {
      continue;
    }
    parsed.push({
      filename,
      contentType,
      content,
      ...(typeof att.size === "number" && Number.isFinite(att.size)
        ? { size: att.size }
        : {}),
      ...(typeof att.contentId === "string" && att.contentId.length > 0
        ? { contentId: att.contentId }
        : {}),
    });
  }
  return parsed.length > 0 ? parsed : undefined;
}

/**
 * Parse an RFC 5322 address like `"Alice <alice@example.com>"` into its
 * components. Returns the raw email address and optional display name.
 */
export function parseEmailAddress(raw: string): {
  address: string;
  displayName?: string;
} {
  const match = raw.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) {
    const name = match[1].trim().replace(/^["']|["']$/g, "");
    return { address: match[2].trim(), displayName: name || undefined };
  }
  return { address: raw.trim() };
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
  const senderAuthenticated =
    typeof payload.senderAuthenticated === "boolean"
      ? payload.senderAuthenticated
      : undefined;
  const attachments = parseEmailAttachments(payload.attachments);

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
    ...(senderAuthenticated !== undefined ? { senderAuthenticated } : {}),
    ...(attachments ? { attachments } : {}),
  };
}
