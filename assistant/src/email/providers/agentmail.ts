/**
 * AgentMail adapter — implements EmailProvider using the agentmail SDK.
 *
 * This is pure transport/integration logic. No guardrails here.
 */

import type { AgentMailClient } from 'agentmail';
import type { EmailProvider, SetupDomainOpts, CreateInboxOpts, EnsureInboxesOpts, SetupWebhookOpts, CreateDraftOpts, ListDraftsOpts, ListMessagesOpts, ListThreadsOpts } from '../provider.js';
import type { EmailDomain, DnsRecord, EmailInbox, EmailDraft, EmailMessage, EmailThread, EmailWebhook, ProviderHealth, SendResult } from '../types.js';
import { ConfigError } from '../../util/errors.js';

const DEFAULT_INBOX_PREFIXES = ['hello', 'support', 'ops'];

export class AgentMailProvider implements EmailProvider {
  readonly name = 'agentmail';
  private client: AgentMailClient;

  constructor(client: AgentMailClient) {
    this.client = client;
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  async health(): Promise<ProviderHealth> {
    const response = await this.client.inboxes.list();
    const inboxes = response.inboxes.map(mapInbox);
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
    const result = await this.client.domains.create({
      domain: opts.domain,
      feedbackEnabled: false,
    });
    return mapDomain(result);
  }

  async getDomainDnsRecords(domain: string): Promise<DnsRecord[]> {
    const domainObj = await this.client.domains.get(domain);
    return (domainObj.records ?? []).map((r): DnsRecord => ({
      type: r.type,
      name: r.name,
      value: r.value,
      priority: r.priority,
    }));
  }

  async verifyDomain(domain: string): Promise<EmailDomain> {
    await this.client.domains.verify(domain);
    const result = await this.client.domains.get(domain);
    return mapDomain(result);
  }

  // -------------------------------------------------------------------------
  // Inbox management
  // -------------------------------------------------------------------------

  async createInbox(opts: CreateInboxOpts): Promise<EmailInbox> {
    const params: Record<string, unknown> = { username: opts.username };
    if (opts.domain) params.domain = opts.domain;
    if (opts.displayName) params.displayName = opts.displayName;
    const inbox = await this.client.inboxes.create(params as Parameters<typeof this.client.inboxes.create>[0]);
    return mapInbox(inbox);
  }

  async listInboxes(): Promise<EmailInbox[]> {
    const response = await this.client.inboxes.list();
    return response.inboxes.map(mapInbox);
  }

  async ensureInboxes(opts: EnsureInboxesOpts): Promise<EmailInbox[]> {
    const prefixes = opts.prefixes ?? DEFAULT_INBOX_PREFIXES;
    const results: EmailInbox[] = [];
    for (const prefix of prefixes) {
      const inbox = await this.client.inboxes.create({
        username: prefix,
        domain: opts.domain,
        displayName: `${prefix.charAt(0).toUpperCase() + prefix.slice(1)} (${opts.domain})`,
      });
      results.push(mapInbox(inbox));
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // Webhook setup
  // -------------------------------------------------------------------------

  async setupWebhook(opts: SetupWebhookOpts): Promise<EmailWebhook> {
    const result = await this.client.webhooks.create({
      url: opts.url,
      eventTypes: (opts.events as import('agentmail').AgentMail.EventType[]) ?? ['message.received'],
    });
    return {
      id: result.webhookId,
      url: result.url,
      secret: result.secret,
      events: result.eventTypes ?? [],
      createdAt: result.createdAt.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Draft lifecycle
  // -------------------------------------------------------------------------

  async createDraft(opts: CreateDraftOpts): Promise<EmailDraft> {
    const params: Record<string, unknown> = {
      to: opts.to,
      subject: opts.subject,
      text: opts.body,
    };
    if (opts.cc) params.cc = opts.cc;
    if (opts.inReplyTo) params.inReplyTo = opts.inReplyTo;

    const result = await this.client.inboxes.drafts.create(opts.inboxId, params);
    return mapDraft(result);
  }

  async listDrafts(opts?: ListDraftsOpts): Promise<EmailDraft[]> {
    const inboxId = opts?.inboxId ?? await this.resolveDefaultInbox();
    const result = await this.client.inboxes.drafts.list(inboxId);
    return result.drafts.map(mapDraftItem);
  }

  async getDraft(draftId: string, inboxId?: string): Promise<EmailDraft> {
    const inbox = inboxId ?? await this.resolveDefaultInbox();
    const result = await this.client.inboxes.drafts.get(inbox, draftId);
    return mapDraft(result);
  }

  async deleteDraft(draftId: string, inboxId?: string): Promise<void> {
    const inbox = inboxId ?? await this.resolveDefaultInbox();
    await this.client.inboxes.drafts.delete(inbox, draftId);
  }

  async sendDraft(draftId: string, inboxId?: string): Promise<SendResult> {
    const inbox = inboxId ?? await this.resolveDefaultInbox();
    const result = await this.client.inboxes.drafts.send(inbox, draftId, {});
    return {
      messageId: result.messageId,
      threadId: result.threadId,
    };
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  async listMessages(opts?: ListMessagesOpts): Promise<EmailMessage[]> {
    const inboxId = opts?.inboxId ?? await this.resolveDefaultInbox();
    const result = await this.client.inboxes.messages.list(inboxId);
    let messages = result.messages.map(mapMessageItem);
    // The SDK doesn't support thread filtering natively — filter client-side
    if (opts?.threadId) {
      messages = messages.filter(m => m.threadId === opts.threadId);
    }
    return messages;
  }

  async getMessage(messageId: string, inboxId?: string): Promise<EmailMessage> {
    const inbox = inboxId ?? await this.resolveDefaultInbox();
    const result = await this.client.inboxes.messages.get(inbox, messageId);
    return mapMessage(result);
  }

  // -------------------------------------------------------------------------
  // Threads
  // -------------------------------------------------------------------------

  async listThreads(opts?: ListThreadsOpts): Promise<EmailThread[]> {
    const inboxId = opts?.inboxId ?? await this.resolveDefaultInbox();
    const result = await this.client.inboxes.threads.list(inboxId);
    return result.threads.map(mapThreadItem);
  }

  async getThread(threadId: string): Promise<EmailThread> {
    const result = await this.client.threads.get(threadId);
    return mapThreadFull(result);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async resolveDefaultInbox(): Promise<string> {
    const inboxes = await this.client.inboxes.list();
    if (inboxes.inboxes.length > 0) {
      return inboxes.inboxes[0].inboxId;
    }
    throw new ConfigError('No inboxes found. Run: vellum email setup inboxes --domain <domain>');
  }
}

// ---------------------------------------------------------------------------
// Mappers: AgentMail SDK types → canonical types
// ---------------------------------------------------------------------------

function mapDomain(d: import('agentmail').AgentMail.Domain): EmailDomain {
  return {
    id: d.domainId,
    domain: d.domainId,
    verified: d.status === 'VERIFIED',
    createdAt: d.createdAt.toISOString(),
  };
}

function mapInbox(i: import('agentmail').AgentMail.inboxes.Inbox): EmailInbox {
  return {
    id: i.inboxId,
    address: i.inboxId,
    displayName: i.displayName,
    createdAt: i.createdAt.toISOString(),
  };
}

function mapDraft(d: import('agentmail').AgentMail.Draft): EmailDraft {
  return {
    id: d.draftId,
    inboxId: d.inboxId,
    to: d.to ?? [],
    cc: d.cc,
    bcc: d.bcc,
    subject: d.subject ?? '',
    body: d.text ?? '',
    html: d.html,
    inReplyTo: d.inReplyTo,
    threadId: d.threadId,
    status: mapSendStatus(d.sendStatus),
    createdAt: d.createdAt.toISOString(),
  };
}

function mapDraftItem(d: import('agentmail').AgentMail.DraftItem): EmailDraft {
  return {
    id: d.draftId,
    inboxId: d.inboxId,
    to: d.to ?? [],
    cc: d.cc,
    bcc: d.bcc,
    subject: d.subject ?? '',
    body: '',
    threadId: d.threadId,
    status: mapSendStatus(d.sendStatus),
    createdAt: d.updatedAt.toISOString(),
  };
}

function mapSendStatus(status?: string): EmailDraft['status'] {
  switch (status) {
    case 'sent': return 'sent';
    case 'sending': return 'approved';
    case 'failed': return 'rejected';
    default: return 'pending';
  }
}

function mapMessageItem(m: import('agentmail').AgentMail.MessageItem): EmailMessage {
  return {
    id: m.messageId,
    threadId: m.threadId,
    inboxId: m.inboxId,
    from: m.from,
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    receivedAt: m.createdAt.toISOString(),
  };
}

function mapMessage(m: import('agentmail').AgentMail.Message): EmailMessage {
  return {
    id: m.messageId,
    threadId: m.threadId,
    inboxId: m.inboxId,
    from: m.from,
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    body: m.text,
    html: m.html,
    receivedAt: m.createdAt.toISOString(),
  };
}

function mapThreadItem(t: import('agentmail').AgentMail.ThreadItem): EmailThread {
  return {
    id: t.threadId,
    subject: t.subject,
    participants: [...(t.senders ?? []), ...(t.recipients ?? [])],
    messageCount: t.messageCount,
    lastMessageAt: t.timestamp.toISOString(),
  };
}

function mapThreadFull(t: import('agentmail').AgentMail.Thread): EmailThread {
  return {
    id: t.threadId,
    subject: t.subject,
    participants: [...(t.senders ?? []), ...(t.recipients ?? [])],
    messageCount: t.messageCount,
    lastMessageAt: t.timestamp.toISOString(),
  };
}
