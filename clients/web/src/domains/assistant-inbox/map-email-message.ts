import type { EmailMessage } from "@/generated/api/types.gen";

import type { EmailAttachment, EmailDetailData, InboxEmail } from "./types";

/**
 * A platform list row as the inbox draws it. The list carries no display
 * names, preview, body, or attachments, so those fields are left unset and
 * the row renders without them until the detail fetch fills the last two.
 */
export function mapEmailMessage(message: EmailMessage): InboxEmail {
  return {
    id: message.id,
    direction: message.direction === "outbound" ? "outbound" : "inbound",
    from: { address: message.from_address },
    to: message.to_addresses.map((address) => ({ address })),
    subject: message.subject,
    createdAt: message.created_at,
  };
}

/** The daemon's `email/attachment-list` row, as the inbox draws it. */
export function mapAttachment(row: {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}): EmailAttachment {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
  };
}

/**
 * Plain text out of an HTML body, for a message that carried no text part.
 * Block boundaries become line breaks so paragraphs survive; the parser is
 * the browser's own, so entities decode and nothing executes.
 */
export function htmlToPlainText(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n\n");
  const doc = new DOMParser().parseFromString(withBreaks, "text/html");
  return (doc.body.textContent ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The body the reading pane shows, from whichever parts the message has.
 * Text wins over HTML because it is the sender's own plain rendering; HTML is
 * flattened only when no text part came.
 */
export function pickBody(parts: {
  body_text?: string | null;
  body_html?: string | null;
}): string {
  const text = parts.body_text?.trim();
  if (text) {
    return text;
  }
  const html = parts.body_html?.trim();
  if (html) {
    return htmlToPlainText(html);
  }
  return "";
}

/** Joins the two daemon reads into what the reading pane needs. */
export function toDetailData(
  parts: { body_text?: string | null; body_html?: string | null },
  attachments: EmailAttachment[],
): EmailDetailData {
  return { body: pickBody(parts), attachments };
}
