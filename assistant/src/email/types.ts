/**
 * Canonical email types — provider-agnostic.
 *
 * All provider adapters normalize to/from these types.
 * The CLI and service layer only ever see these.
 */

// ---------------------------------------------------------------------------
// Domain & DNS
// ---------------------------------------------------------------------------

export interface EmailDomain {
  id: string;
  domain: string;
  verified: boolean;
  createdAt: string;
}

export interface DnsRecord {
  type: string; // TXT, CNAME, MX
  name: string;
  value: string;
  priority?: number;
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

export interface EmailInbox {
  id: string;
  address: string;
  displayName?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

export type DraftStatus = "pending" | "approved" | "sent" | "rejected";

export interface EmailDraft {
  id: string;
  inboxId: string;
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  html?: string;
  inReplyTo?: string;
  threadId?: string;
  status: DraftStatus;
  createdAt: string;
}

export interface CreateDraftInput {
  from: string;
  to: string;
  subject: string;
  body: string;
  cc?: string;
  inReplyTo?: string;
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export interface EmailMessage {
  id: string;
  threadId: string;
  inboxId: string;
  from?: string;
  to: string[];
  cc?: string[];
  subject?: string;
  body?: string;
  html?: string;
  receivedAt: string;
}

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

export interface EmailThread {
  id: string;
  subject?: string;
  participants: string[];
  messageCount: number;
  lastMessageAt: string;
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

export interface EmailWebhook {
  id: string;
  url: string;
  secret?: string;
  events: string[];
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Health / Status
// ---------------------------------------------------------------------------

export interface ProviderHealth {
  provider: string;
  ok: boolean;
  inboxes: EmailInbox[];
}

// ---------------------------------------------------------------------------
// Send result
// ---------------------------------------------------------------------------

export interface SendResult {
  messageId: string;
  threadId?: string;
}
