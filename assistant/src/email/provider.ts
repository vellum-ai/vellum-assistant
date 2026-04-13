/**
 * Email provider interface — the contract every adapter must implement.
 *
 * Providers are pure transport/integration logic.
 * Guardrails and business rules live in the service layer.
 */

import type {
  DnsRecord,
  EmailDomain,
  EmailDraft,
  EmailInbox,
  EmailMessage,
  EmailThread,
  EmailWebhook,
  ProviderHealth,
  SendResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Setup operations
// ---------------------------------------------------------------------------

export interface SetupDomainOpts {
  domain: string;
  dryRun?: boolean;
}

export interface EnsureInboxesOpts {
  domain: string;
  prefixes?: string[];
}

export interface CreateInboxOpts {
  /** Username/local part (e.g. "sam"). */
  username: string;
  /** Domain (e.g. "vellum.me"). If omitted, provider uses its default. */
  domain?: string;
  /** Display name (e.g. "Samwise"). */
  displayName?: string;
}

export interface SetupWebhookOpts {
  url: string;
  secret?: string;
  events?: string[];
}

// ---------------------------------------------------------------------------
// Draft operations
// ---------------------------------------------------------------------------

export interface CreateDraftOpts {
  inboxId: string;
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  inReplyTo?: string;
}

export interface ListDraftsOpts {
  inboxId?: string;
}

// ---------------------------------------------------------------------------
// Message / thread operations
// ---------------------------------------------------------------------------

export interface ListMessagesOpts {
  inboxId?: string;
  threadId?: string;
}

export interface ListThreadsOpts {
  inboxId?: string;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface EmailProvider {
  /** Unique provider identifier (e.g. 'platform'). */
  readonly name: string;

  // --- Health ---
  health(): Promise<ProviderHealth>;

  // --- Domain setup ---
  setupDomain(opts: SetupDomainOpts): Promise<EmailDomain>;
  getDomainDnsRecords(domain: string): Promise<DnsRecord[]>;
  verifyDomain(domain: string): Promise<EmailDomain>;

  // --- Inbox setup ---
  createInbox(opts: CreateInboxOpts): Promise<EmailInbox>;
  listInboxes(): Promise<EmailInbox[]>;
  ensureInboxes(opts: EnsureInboxesOpts): Promise<EmailInbox[]>;

  // --- Webhook setup ---
  setupWebhook(opts: SetupWebhookOpts): Promise<EmailWebhook>;

  // --- Draft lifecycle ---
  createDraft(opts: CreateDraftOpts): Promise<EmailDraft>;
  listDrafts(opts?: ListDraftsOpts): Promise<EmailDraft[]>;
  getDraft(draftId: string, inboxId?: string): Promise<EmailDraft>;
  deleteDraft(draftId: string, inboxId?: string): Promise<void>;
  sendDraft(draftId: string, inboxId?: string): Promise<SendResult>;

  // --- Messages ---
  listMessages(opts?: ListMessagesOpts): Promise<EmailMessage[]>;
  getMessage(messageId: string, inboxId?: string): Promise<EmailMessage>;

  // --- Threads ---
  listThreads(opts?: ListThreadsOpts): Promise<EmailThread[]>;
  getThread(threadId: string): Promise<EmailThread>;
}
