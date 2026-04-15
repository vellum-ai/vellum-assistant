/**
 * Centralized platform API client.
 *
 * Owns managed proxy context resolution, prerequisite validation, and
 * authenticated fetch for all platform API calls.
 *
 * ## Ergonomic sub-clients
 *
 * Instead of manually constructing `/v1/assistants/{id}/...` paths, use
 * the `assistant` namespace:
 *
 * ```ts
 * const client = await VellumPlatformClient.create();
 * const addresses = await client.assistant.emailAddresses.list();
 * const msg = await client.assistant.emails.get(messageId);
 * ```
 *
 * The `assistant` getter calls `requireAssistantId()` internally, so
 * callers never need to null-check the assistant ID themselves.
 */

import { getPlatformAssistantId } from "../config/env.js";
import { resolveManagedProxyContext } from "../providers/managed-proxy/context.js";
import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";

// ---------------------------------------------------------------------------
// Sub-client types
// ---------------------------------------------------------------------------

export class AssistantEmailAddresses {
  constructor(private readonly client: AssistantSubClient) {}

  list(): Promise<Response> {
    return this.client.fetch("/email-addresses/");
  }

  create(username: string): Promise<Response> {
    return this.client.fetch("/email-addresses/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });
  }

  delete(addressId: string): Promise<Response> {
    return this.client.fetch(
      `/email-addresses/${encodeURIComponent(addressId)}/`,
      { method: "DELETE" },
    );
  }

  getStatus(addressId: string): Promise<Response> {
    return this.client.fetch(
      `/email-addresses/${encodeURIComponent(addressId)}/status/`,
    );
  }
}

export class AssistantEmails {
  constructor(private readonly client: AssistantSubClient) {}

  list(params?: URLSearchParams): Promise<Response> {
    const qs = params?.toString();
    return this.client.fetch(`/emails/${qs ? `?${qs}` : ""}`);
  }

  get(messageId: string): Promise<Response> {
    return this.client.fetch(`/emails/${encodeURIComponent(messageId)}/`);
  }

  listAttachments(messageId: string): Promise<Response> {
    return this.client.fetch(
      `/emails/${encodeURIComponent(messageId)}/attachments/`,
    );
  }

  getAttachment(messageId: string, attachmentId: string): Promise<Response> {
    return this.client.fetch(
      `/emails/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/`,
    );
  }

  downloadAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<Response> {
    return this.client.fetch(
      `/emails/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/download/`,
    );
  }
}

export class AssistantOAuth {
  constructor(private readonly client: AssistantSubClient) {}

  connections(params?: URLSearchParams): Promise<Response> {
    const qs = params?.toString();
    return this.client.fetch(`/oauth/connections/${qs ? `?${qs}` : ""}`);
  }

  startConnect(provider: string): Promise<Response> {
    return this.client.fetch(`/oauth/${encodeURIComponent(provider)}/start/`, {
      method: "POST",
    });
  }

  disconnect(connectionId: string, init?: RequestInit): Promise<Response> {
    return this.client.fetch(
      `/oauth/connections/${encodeURIComponent(connectionId)}/disconnect/`,
      { method: "POST", ...init },
    );
  }

  managedCatalog(): Promise<Response> {
    return this.client.fetch("/oauth/managed/catalog/", {
      headers: { Accept: "application/json" },
    });
  }

  externalProviderProxy(
    connectionId: string,
    init?: RequestInit,
  ): Promise<Response> {
    return this.client.fetch(
      `/external-provider-proxy/${encodeURIComponent(connectionId)}/`,
      init,
    );
  }
}

/**
 * Scoped sub-client for `/v1/assistants/{id}/...` endpoints.
 *
 * Created lazily via `VellumPlatformClient.assistant`. All paths are
 * relative to the assistant base path.
 */
export class AssistantSubClient {
  readonly emailAddresses: AssistantEmailAddresses;
  readonly emails: AssistantEmails;
  readonly oauth: AssistantOAuth;

  constructor(
    private readonly root: VellumPlatformClient,
    private readonly id: string,
  ) {
    this.emailAddresses = new AssistantEmailAddresses(this);
    this.emails = new AssistantEmails(this);
    this.oauth = new AssistantOAuth(this);
  }

  /**
   * Authenticated fetch scoped to this assistant.
   *
   * `subpath` is appended to `/v1/assistants/{id}` — it should start
   * with `/` (e.g. `/email-addresses/`).
   */
  fetch(subpath: string, init?: RequestInit): Promise<Response> {
    return this.root.fetch(
      `/v1/assistants/${encodeURIComponent(this.id)}${subpath}`,
      init,
    );
  }

  /**
   * PATCH the assistant record itself.
   */
  patch(body: Record<string, unknown>, init?: RequestInit): Promise<Response> {
    return this.fetch("/", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...init,
    });
  }
}

// ---------------------------------------------------------------------------
// Main client
// ---------------------------------------------------------------------------

export class VellumPlatformClient {
  private readonly platformBaseUrl: string;
  private readonly apiKey: string;
  private readonly assistantId: string;

  private _assistant: AssistantSubClient | undefined;

  private constructor(
    platformBaseUrl: string,
    apiKey: string,
    assistantId: string,
  ) {
    this.platformBaseUrl = platformBaseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.assistantId = assistantId;
  }

  /**
   * Create a platform client by resolving managed proxy context.
   *
   * First tries the in-memory managed proxy context (available when the daemon
   * has rehydrated env overrides). Falls back to reading platform credentials
   * directly from the credential store so that standalone CLI invocations work
   * without the daemon having run its rehydration step.
   *
   * Returns `null` when auth prerequisites are missing (not logged in, no API
   * key). The assistant ID is resolved but not required — callers that need it
   * should check `platformAssistantId` themselves.
   */
  static async create(): Promise<VellumPlatformClient | null> {
    const ctx = await resolveManagedProxyContext();

    let baseUrl = ctx.enabled ? ctx.platformBaseUrl : "";
    let apiKey = ctx.enabled ? ctx.assistantApiKey : "";
    let assistantId = getPlatformAssistantId();

    // Fall back to credential store for values not yet rehydrated (standalone CLI).
    if (!baseUrl) {
      baseUrl =
        (await getSecureKeyAsync(
          credentialKey("vellum", "platform_base_url"),
        )) ?? "";
    }
    if (!apiKey) {
      apiKey =
        (await getSecureKeyAsync(
          credentialKey("vellum", "assistant_api_key"),
        )) ?? "";
    }
    if (!assistantId) {
      assistantId =
        (
          await getSecureKeyAsync(
            credentialKey("vellum", "platform_assistant_id"),
          )
        )?.trim() ?? "";
    }

    if (!baseUrl || !apiKey) return null;

    return new VellumPlatformClient(baseUrl, apiKey, assistantId);
  }

  /**
   * Authenticated fetch against the platform API.
   *
   * Prepends `platformBaseUrl` to `path` and injects the `Api-Key` auth header.
   * Callers handle response parsing and domain-specific error mapping.
   */
  async fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.platformBaseUrl}${path}`;
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Api-Key ${this.apiKey}`);

    return fetch(url, { ...init, headers });
  }

  get baseUrl(): string {
    return this.platformBaseUrl;
  }

  get assistantApiKey(): string {
    return this.apiKey;
  }

  get platformAssistantId(): string {
    return this.assistantId;
  }

  /**
   * Throws if the assistant ID is not configured.
   *
   * Replaces the boilerplate `if (!client.platformAssistantId) throw ...`
   * pattern scattered across callers.
   */
  requireAssistantId(): string {
    if (!this.assistantId) {
      throw new Error(
        "Assistant ID not configured. Set PLATFORM_ASSISTANT_ID or run: assistant platform connect",
      );
    }
    return this.assistantId;
  }

  /**
   * Scoped sub-client for the current assistant's API surface.
   *
   * Throws if the assistant ID is not configured (calls `requireAssistantId`).
   */
  get assistant(): AssistantSubClient {
    if (!this._assistant) {
      this._assistant = new AssistantSubClient(this, this.requireAssistantId());
    }
    return this._assistant;
  }
}
