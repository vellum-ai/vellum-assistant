/**
 * Vellum email provider — implements EmailProvider using the Vellum platform API.
 *
 * Calls are routed to the Vellum platform's email endpoints.
 * This is the only supported email provider for the CLI.
 */

import type {
  EmailProvider,
  SetupDomainOpts,
  CreateInboxOpts,
  EnsureInboxesOpts,
  SetupWebhookOpts,
  CreateDraftOpts,
  ListDraftsOpts,
  ListMessagesOpts,
  ListThreadsOpts,
} from "../provider.js";
import type {
  EmailDomain,
  DnsRecord,
  EmailInbox,
  EmailDraft,
  EmailMessage,
  EmailThread,
  EmailWebhook,
  ProviderHealth,
  SendResult,
} from "../types.js";

const DEFAULT_INBOX_PREFIXES = ["hello", "support", "ops"];

/**
 * Make an authenticated request to the Vellum platform email API.
 * Throws if the API key is not configured or the request fails.
 */
async function vellumFetch(
  apiKey: string,
  baseUrl: string,
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Vellum email API error: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return undefined;
}

export class VellumProvider implements EmailProvider {
  readonly name = "vellum";
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl ?? "https://api.vellum.ai";
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  async health(): Promise<ProviderHealth> {
    const inboxes = await this.listInboxes();
    return { provider: this.name, ok: true, inboxes };
  }

  // -------------------------------------------------------------------------
  // Domain setup
  // -------------------------------------------------------------------------

  async setupDomain(opts: SetupDomainOpts): Promise<EmailDomain> {
    if (opts.dryRun) {
      return {
        id: `dry-run:${opts.domain}`,
        domain: opts.domain,
        verified: false,
        createdAt: new Date().toISOString(),
      };
    }
    const result = await vellumFetch(this.apiKey, this.baseUrl, "/v1/email/domains", {
      method: "POST",
      body: { domain: opts.domain },
    });
    return result as EmailDomain;
  }

  async getDomainDnsRecords(domain: string): Promise<DnsRecord[]> {
    const result = await vellumFetch(
      this.apiKey,
      this.baseUrl,
      `/v1/email/domains/${encodeURIComponent(domain)}/dns`,
    );
    return (result as { records: DnsRecord[] }).records;
  }

  async verifyDomain(domain: string): Promise<EmailDomain> {
    const result = await vellumFetch(
      this.apiKey,
      this.baseUrl,
      `/v1/email/domains/${encodeURIComponent(domain)}/verify`,
      { method: "POST" },
    );
    return result as EmailDomain;
  }

  // -------------------------------------------------------------------------
  // Inbox management
  // -------------------------------------------------------------------------

  async createInbox(opts: CreateInboxOpts): Promise<EmailInbox> {
    const result = await vellumFetch(this.apiKey, this.baseUrl, "/v1/email/inboxes", {
      method: "POST",
      body: {
        username: opts.username,
        domain: opts.domain,
        display_name: opts.displayName,
      },
    });
    return result as EmailInbox;
  }

  async listInboxes(): Promise<EmailInbox[]> {
    const result = await vellumFetch(this.apiKey, this.baseUrl, "/v1/email/inboxes");
    return (result as { inboxes: EmailInbox[] }).inboxes;
  }

  async ensureInboxes(opts: EnsureInboxesOpts): Promise<EmailInbox[]> {
    const prefixes = opts.prefixes ?? DEFAULT_INBOX_PREFIXES;
    const results: EmailInbox[] = [];
    for (const prefix of prefixes) {
      const inbox = await this.createInbox({
        username: prefix,
        domain: opts.domain,
        displayName: `${prefix.charAt(0).toUpperCase() + prefix.slice(1)} (${opts.domain})`,
      });
      results.push(inbox);
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // Webhook setup
  // -------------------------------------------------------------------------

  async setupWebhook(opts: SetupWebhookOpts): Promise<EmailWebhook> {
    const result = await vellumFetch(this.apiKey, this.baseUrl, "/v1/email/webhooks", {
      method: "POST",
      body: {
        url: opts.url,
        secret: opts.secret,
        events: opts.events ?? ["message.received"],
      },
    });
    return result as EmailWebhook;
  }

  // -------------------------------------------------------------------------
  // Draft lifecycle
  // -------------------------------------------------------------------------

  async createDraft(opts: CreateDraftOpts): Promise<EmailDraft> {
    const result = await vellumFetch(
      this.apiKey,
      this.baseUrl,
      `/v1/email/inboxes/${encodeURIComponent(opts.inboxId)}/drafts`,
      {
        method: "POST",
        body: {
          to: opts.to,
          subject: opts.subject,
          body: opts.body,
          cc: opts.cc,
          in_reply_to: opts.inReplyTo,
        },
      },
    );
    return result as EmailDraft;
  }

  async listDrafts(opts?: ListDraftsOpts): Promise<EmailDraft[]> {
    const inboxId = opts?.inboxId ?? (await this.resolveDefaultInbox());
    const result = await vellumFetch(
      this.apiKey,
      this.baseUrl,
      `/v1/email/inboxes/${encodeURIComponent(inboxId)}/drafts`,
    );
    return (result as { drafts: EmailDraft[] }).drafts;
  }

  async getDraft(draftId: string, inboxId?: string): Promise<EmailDraft> {
    const inbox = inboxId ?? (await this.resolveDefaultInbox());
    const result = await vellumFetch(
      this.apiKey,
      this.baseUrl,
      `/v1/email/inboxes/${encodeURIComponent(inbox)}/drafts/${encodeURIComponent(draftId)}`,
    );
    return result as EmailDraft;
  }

  async deleteDraft(draftId: string, inboxId?: string): Promise<void> {
    const inbox = inboxId ?? (await this.resolveDefaultInbox());
    await vellumFetch(
      this.apiKey,
      this.baseUrl,
      `/v1/email/inboxes/${encodeURIComponent(inbox)}/drafts/${encodeURIComponent(draftId)}`,
      { method: "DELETE" },
    );
  }

  async sendDraft(draftId: string, inboxId?: string): Promise<SendResult> {
    const inbox = inboxId ?? (await this.resolveDefaultInbox());
    const result = await vellumFetch(
      this.apiKey,
      this.baseUrl,
      `/v1/email/inboxes/${encodeURIComponent(inbox)}/drafts/${encodeURIComponent(draftId)}/send`,
      { method: "POST" },
    );
    return result as SendResult;
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  async listMessages(opts?: ListMessagesOpts): Promise<EmailMessage[]> {
    const inboxId = opts?.inboxId ?? (await this.resolveDefaultInbox());
    let path = `/v1/email/inboxes/${encodeURIComponent(inboxId)}/messages`;
    if (opts?.threadId) {
      path += `?thread_id=${encodeURIComponent(opts.threadId)}`;
    }
    const result = await vellumFetch(this.apiKey, this.baseUrl, path);
    return (result as { messages: EmailMessage[] }).messages;
  }

  async getMessage(messageId: string, inboxId?: string): Promise<EmailMessage> {
    const inbox = inboxId ?? (await this.resolveDefaultInbox());
    const result = await vellumFetch(
      this.apiKey,
      this.baseUrl,
      `/v1/email/inboxes/${encodeURIComponent(inbox)}/messages/${encodeURIComponent(messageId)}`,
    );
    return result as EmailMessage;
  }

  // -------------------------------------------------------------------------
  // Threads
  // -------------------------------------------------------------------------

  async listThreads(opts?: ListThreadsOpts): Promise<EmailThread[]> {
    const inboxId = opts?.inboxId ?? (await this.resolveDefaultInbox());
    const result = await vellumFetch(
      this.apiKey,
      this.baseUrl,
      `/v1/email/inboxes/${encodeURIComponent(inboxId)}/threads`,
    );
    return (result as { threads: EmailThread[] }).threads;
  }

  async getThread(threadId: string): Promise<EmailThread> {
    const result = await vellumFetch(
      this.apiKey,
      this.baseUrl,
      `/v1/email/threads/${encodeURIComponent(threadId)}`,
    );
    return result as EmailThread;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async resolveDefaultInbox(): Promise<string> {
    const inboxes = await this.listInboxes();
    if (inboxes.length > 0) {
      return inboxes[0].id;
    }
    throw new Error(
      "No inboxes found. Run: vellum email setup inboxes --domain <domain>",
    );
  }
}
