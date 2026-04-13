/**
 * Email service facade — the single entry point for all email operations.
 *
 * Wraps the active provider and enforces guardrails.
 * The CLI layer calls only this; never the provider directly.
 */

import {
  getNestedValue,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../config/loader.js";
import { ConfigError } from "../util/errors.js";
import {
  addAddressRule,
  type AddressRule,
  checkSendGuardrails,
  getGuardrailsStatus,
  incrementDailySendCount,
  listRules,
  removeAddressRule,
  setDailySendCap,
  setOutboundPaused,
} from "./guardrails.js";
import type { EmailProvider } from "./provider.js";
import type {
  CreateDraftInput,
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
// Guardrail error
// ---------------------------------------------------------------------------

export class GuardrailError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GuardrailError";
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class EmailService {
  private providerInstance: EmailProvider | null = null;

  /** Get or lazily create the provider. */
  private async provider(): Promise<EmailProvider> {
    if (!this.providerInstance) {
      throw new ConfigError(
        "Local email providers have been removed. Email is now handled through the platform. " +
          "Use `assistant email register` to set up an email address.",
      );
    }
    return this.providerInstance;
  }

  /** Force re-creation of the provider (e.g. after `provider set`). */
  resetProvider(): void {
    this.providerInstance = null;
    this.primaryAddressResolved = false;
    this.cachedPrimaryAddress = undefined;
  }

  // =========================================================================
  // Provider info
  // =========================================================================

  getProviderName(): string {
    return "platform";
  }

  setProvider(_name: string): void {
    const raw = loadRawConfig();
    setNestedValue(raw, "integrations.email.provider", _name);
    saveRawConfig(raw);
    this.resetProvider();
  }

  // =========================================================================
  // Health / Status
  // =========================================================================

  async status(): Promise<{
    provider: string;
    health: ProviderHealth;
    guardrails: ReturnType<typeof getGuardrailsStatus>;
  }> {
    const p = await this.provider();
    const health = await p.health();
    return {
      provider: p.name,
      health,
      guardrails: getGuardrailsStatus(),
    };
  }

  // =========================================================================
  // Primary inbox address (cached)
  // =========================================================================

  private primaryAddressResolved = false;
  private cachedPrimaryAddress: string | undefined;

  /**
   * Return the assistant's primary inbox email address, caching the result
   * for the lifetime of this service instance. Returns `undefined` when no
   * inboxes are configured or the provider is unavailable.
   */
  async getPrimaryInboxAddress(): Promise<string | undefined> {
    if (this.primaryAddressResolved) {
      return this.cachedPrimaryAddress;
    }
    try {
      const p = await this.provider();
      const health = await p.health();
      this.cachedPrimaryAddress =
        health.inboxes.length > 0 ? health.inboxes[0].address : undefined;
    } catch {
      this.cachedPrimaryAddress = undefined;
    }

    // Only cache positive results from the provider so a missing inbox is
    // retried on next call (e.g. user sets up email after initial miss).
    if (this.cachedPrimaryAddress !== undefined) {
      this.primaryAddressResolved = true;
      return this.cachedPrimaryAddress;
    }

    // Fall back to the statically configured email address in workspace config
    // when the provider can't list inboxes (e.g. provider temporarily unavailable).
    // Intentionally NOT setting primaryAddressResolved so the provider is retried
    // on the next call — the fallback is a best-effort stopgap, not authoritative.
    try {
      const raw = loadRawConfig();
      const configured = getNestedValue(raw, "email.address");
      if (typeof configured === "string" && configured.length > 0) {
        return configured;
      }
    } catch {
      // Config unavailable — leave as undefined
    }
    return undefined;
  }

  // =========================================================================
  // Domain setup
  // =========================================================================

  async setupDomain(domain: string, dryRun = false): Promise<EmailDomain> {
    const p = await this.provider();
    return p.setupDomain({ domain, dryRun });
  }

  async getDomainDnsRecords(domain: string): Promise<DnsRecord[]> {
    const p = await this.provider();
    return p.getDomainDnsRecords(domain);
  }

  async verifyDomain(domain: string): Promise<EmailDomain> {
    const p = await this.provider();
    return p.verifyDomain(domain);
  }

  // =========================================================================
  // Inbox management
  // =========================================================================

  async createInbox(
    username: string,
    domain?: string,
    displayName?: string,
  ): Promise<EmailInbox> {
    const p = await this.provider();
    const inbox = await p.createInbox({ username, domain, displayName });
    this.primaryAddressResolved = false;
    this.cachedPrimaryAddress = undefined;
    return inbox;
  }

  async listInboxes(): Promise<EmailInbox[]> {
    const p = await this.provider();
    return p.listInboxes();
  }

  async ensureInboxes(domain: string): Promise<EmailInbox[]> {
    const p = await this.provider();
    const inboxes = await p.ensureInboxes({ domain });
    this.primaryAddressResolved = false;
    this.cachedPrimaryAddress = undefined;
    return inboxes;
  }

  // =========================================================================
  // Webhook setup
  // =========================================================================

  async setupWebhook(url: string, secret?: string): Promise<EmailWebhook> {
    const p = await this.provider();
    return p.setupWebhook({ url, secret });
  }

  // =========================================================================
  // Draft lifecycle
  // =========================================================================

  async createDraft(input: CreateDraftInput): Promise<EmailDraft> {
    const p = await this.provider();
    // Resolve inbox from the "from" address — fail fast if not found
    const health = await p.health();
    if (health.inboxes.length === 0) {
      throw new ConfigError(
        "No inboxes found. Run: assistant email setup inboxes --domain <domain>",
      );
    }
    const inbox = health.inboxes.find(
      (i) => i.address === input.from || i.id === input.from,
    );
    if (!inbox) {
      const available = health.inboxes.map((i) => i.address || i.id).join(", ");
      throw new ConfigError(
        `No inbox matches --from "${input.from}". Available: ${available}`,
      );
    }
    const inboxId = inbox.id;
    return p.createDraft({
      inboxId,
      to: [input.to],
      subject: input.subject,
      body: input.body,
      cc: input.cc ? [input.cc] : undefined,
      inReplyTo: input.inReplyTo,
    });
  }

  async listDrafts(status?: string): Promise<EmailDraft[]> {
    const p = await this.provider();
    const drafts = await p.listDrafts();
    if (status) {
      return drafts.filter((d) => d.status === status);
    }
    return drafts;
  }

  async getDraft(draftId: string, inboxId?: string): Promise<EmailDraft> {
    const p = await this.provider();
    return p.getDraft(draftId, inboxId);
  }

  async deleteDraft(draftId: string, inboxId?: string): Promise<void> {
    const p = await this.provider();
    return p.deleteDraft(draftId, inboxId);
  }

  /**
   * Approve and send a draft. Enforces all guardrails.
   * Throws GuardrailError if blocked.
   * Pass inboxId to avoid incorrect inbox resolution in multi-inbox setups.
   */
  async approveSend(
    draftId: string,
    inboxId?: string,
  ): Promise<SendResult & { dailyCount: number }> {
    const p = await this.provider();

    // Fetch draft to get recipients — pass inboxId for correct scoping
    const draft = await p.getDraft(draftId, inboxId);
    const recipients = [...draft.to, ...(draft.cc ?? []), ...(draft.bcc ?? [])];

    // Check guardrails
    const blocked = checkSendGuardrails(recipients);
    if (blocked) {
      throw new GuardrailError(
        blocked.error,
        `Send blocked: ${blocked.error}`,
        blocked,
      );
    }

    // Send
    const result = await p.sendDraft(draftId, draft.inboxId);
    const dailyCount = incrementDailySendCount();
    return { ...result, dailyCount };
  }

  /**
   * Reject a draft (delete it with a reason marker).
   */
  async rejectDraft(
    draftId: string,
    _reason?: string,
    inboxId?: string,
  ): Promise<void> {
    const p = await this.provider();
    await p.deleteDraft(draftId, inboxId);
  }

  // =========================================================================
  // Inbound / Messages
  // =========================================================================

  async listMessages(
    threadId?: string,
    inboxId?: string,
  ): Promise<EmailMessage[]> {
    const p = await this.provider();
    const opts: { threadId?: string; inboxId?: string } = {};
    if (threadId) opts.threadId = threadId;
    if (inboxId) opts.inboxId = inboxId;
    return p.listMessages(Object.keys(opts).length > 0 ? opts : undefined);
  }

  async getMessage(messageId: string): Promise<EmailMessage> {
    const p = await this.provider();
    return p.getMessage(messageId);
  }

  // =========================================================================
  // Threads
  // =========================================================================

  async listThreads(): Promise<EmailThread[]> {
    const p = await this.provider();
    return p.listThreads();
  }

  async getThread(threadId: string): Promise<EmailThread> {
    const p = await this.provider();
    return p.getThread(threadId);
  }

  // =========================================================================
  // Guardrails (pure local, no provider call)
  // =========================================================================

  getGuardrails() {
    return getGuardrailsStatus();
  }

  setGuardrails(opts: { paused?: boolean; dailyCap?: number }) {
    if (opts.paused !== undefined) setOutboundPaused(opts.paused);
    if (opts.dailyCap !== undefined) setDailySendCap(opts.dailyCap);
    return getGuardrailsStatus();
  }

  addRule(type: "block" | "allow", pattern: string): AddressRule {
    return addAddressRule(type, pattern);
  }

  removeRule(ruleId: string): boolean {
    return removeAddressRule(ruleId);
  }

  listAddressRules(): AddressRule[] {
    return listRules();
  }
}

/** Singleton service instance. */
let instance: EmailService | null = null;

export function getEmailService(): EmailService {
  if (!instance) {
    instance = new EmailService();
  }
  return instance;
}
