/**
 * Centralized platform API client.
 *
 * Owns managed proxy context resolution, prerequisite validation, and
 * authenticated fetch for all platform API calls.
 */

import { getPlatformAssistantId } from "../config/env.js";
import { resolveManagedProxyContext } from "../providers/managed-proxy/context.js";
import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("platform-client");

export class VellumPlatformClient {
  private readonly platformBaseUrl: string;
  private readonly apiKey: string;
  private readonly assistantId: string;

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

    if (!baseUrl || !apiKey) {
      log.debug(
        {
          hasBaseUrl: !!baseUrl,
          hasApiKey: !!apiKey,
          managedProxyEnabled: ctx.enabled,
        },
        "Platform client prerequisites missing — returning null",
      );
      return null;
    }

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
}
