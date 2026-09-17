/**
 * The shapes the Assistant Inbox renders.
 *
 * `InboxEmail` is the platform's `EmailMessage` (id, direction, from, to,
 * subject, created_at) joined with what the daemon's `email/download` and
 * `email/attachment-list` routes add: a body, a preview line, and the
 * attachment listing. Nothing here is fetched yet; the page is a design
 * surface fed from fixtures until the platform joins these reads.
 */

export type EmailDirection = "inbound" | "outbound";

export interface EmailParticipant {
  /** Display name when the header carried one; the address stands in otherwise. */
  name?: string;
  address: string;
}

export interface EmailAttachment {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export interface InboxEmail {
  id: string;
  direction: EmailDirection;
  from: EmailParticipant;
  to: EmailParticipant[];
  subject: string;
  /** The first line or so of the body, for the list row. */
  snippet: string;
  /** Plain-text body; paragraphs separated by blank lines. */
  body: string;
  /** ISO 8601. */
  createdAt: string;
  attachments: EmailAttachment[];
}

/** The platform's `EmailAddressUsage`, trimmed to what the header shows. */
export interface InboxUsage {
  sentToday: number;
  receivedToday: number;
  dailyLimit: number;
}

/** The mailbox folder the list is showing. */
export type InboxFolder = "inbox" | "sent";
