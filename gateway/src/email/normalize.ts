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

/** Lowercased domain of an email address (the text after the last `@`). */
function domainOfEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at === -1) {
    return "";
  }
  return email
    .slice(at + 1)
    .trim()
    .replace(/^[<>]+|[<>]+$/g, "")
    .toLowerCase();
}

/**
 * Relaxed DMARC-style alignment between the visible `From:` domain and an
 * authenticated domain: exact match or an organizational-domain (subdomain)
 * relationship in either direction.
 */
function domainsAligned(fromDomain: string, authDomain: string): boolean {
  if (!fromDomain || !authDomain) {
    return false;
  }
  return (
    fromDomain === authDomain ||
    fromDomain.endsWith("." + authDomain) ||
    authDomain.endsWith("." + fromDomain)
  );
}

/**
 * Decide whether an inbound message's `From:` address is authentic from the
 * `Authentication-Results` header the receiving provider (Mailgun/Resend)
 * stamps after running SPF/DKIM/DMARC. Trust classification keys on the `From:`
 * address, which is trivially spoofable on its own; this binds that address to
 * real authentication so a forged sender cannot inherit guardian/trusted-contact
 * trust.
 *
 * Returns:
 *  - `true`  — DMARC passed, or (when the receiver reported no DMARC
 *              determination — `dmarc=none`, Microsoft 365's
 *              `dmarc=bestguesspass`, or no `dmarc=` verdict at all) DKIM
 *              passed for a domain aligned with the `From:` domain.
 *  - `false` — authentication results were present but did not authenticate the
 *              `From:` address (spoofable sender). A present non-pass DMARC
 *              verdict (`fail`/`temperror`/`permerror`) is authoritative and is
 *              NOT overridden by an aligned DKIM pass — the receiver, which read
 *              the domain's own policy, declined to affirm the visible `From:`.
 *  - `undefined` — no `Authentication-Results` header, so authentication could
 *              not be evaluated (e.g. the receiving-API fetch failed). Callers
 *              omit the signal so `handleInbound` preserves existing behavior
 *              rather than downgrading every sender on missing data.
 *
 * SPF alone is intentionally NOT sufficient: it validates the envelope
 * `MAIL FROM`, not the visible `From:` header a spoofer controls.
 */
export function evaluateSenderAuthentication(args: {
  authResults: string | null | undefined;
  fromEmail: string;
}): boolean | undefined {
  const raw = args.authResults;
  if (!raw) {
    return undefined;
  }
  const results = raw.toLowerCase();

  // The receiver's DMARC verdict is authoritative for the visible RFC5322.From
  // domain: it applied that domain's own published policy (including its
  // alignment mode), which the relaxed DKIM-alignment heuristic below cannot
  // see. So honor a present verdict before falling back:
  //  - `pass` → the From: is authenticated.
  //  - `none` → the domain publishes no DMARC policy, i.e. no determination
  //    exists (materially the same as an absent header); fall through to the
  //    aligned-DKIM check, which is exactly the signal the fallback exists for.
  //  - `bestguesspass` → Microsoft 365's verdict for the same no-policy
  //    situation (no DMARC record published, but an implicit policy would have
  //    passed) — a non-failure, so it also falls through.
  //  - anything else (`fail`, `temperror`, `permerror`, …) → the receiver did
  //    not affirm the From:, so we must NOT substitute our own alignment
  //    heuristic and re-authenticate a sender it declined. Fail closed.
  const dmarc = results.match(/\bdmarc=(\w+)/);
  if (dmarc) {
    const verdict = dmarc[1];
    if (verdict === "pass") {
      return true;
    }
    if (verdict !== "none" && verdict !== "bestguesspass") {
      return false;
    }
  }

  // Fallback: a DKIM pass whose signing domain aligns with the From: domain.
  // Reached only when the receiver made no DMARC determination (no `dmarc=`
  // token, `dmarc=none`, or `dmarc=bestguesspass`). Methods in Authentication-Results are
  // `;`-separated (RFC 8601), so scope each DKIM verdict to the domain in its
  // own method chunk.
  const fromDomain = domainOfEmail(args.fromEmail);
  for (const chunk of results.split(";")) {
    const dkim = chunk.match(/\bdkim=(\w+)/);
    if (!dkim || dkim[1] !== "pass") {
      continue;
    }
    for (const m of chunk.matchAll(/header\.(?:d|i)=@?([^\s;]+)/g)) {
      const authDomain = m[1].trim().replace(/>+$/, "");
      if (domainsAligned(fromDomain, authDomain)) {
        return true;
      }
    }
  }

  return false;
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
