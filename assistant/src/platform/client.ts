/**
 * Centralized platform API client.
 *
 * Owns managed proxy context resolution, prerequisite validation, and
 * authenticated fetch for all platform API calls that use Api-Key auth.
 */

import { getPlatformAssistantId } from "../config/env.js";
import { resolveManagedProxyContext } from "../providers/managed-proxy/context.js";

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
   * Returns `null` when auth prerequisites are missing (not logged in, no API
   * key). The assistant ID is resolved but not required — callers that need it
   * should check `platformAssistantId` themselves.
   */
  static async create(): Promise<VellumPlatformClient | null> {
    const ctx = await resolveManagedProxyContext();
    if (!ctx.enabled) return null;

    const assistantId = getPlatformAssistantId();

    return new VellumPlatformClient(
      ctx.platformBaseUrl,
      ctx.assistantApiKey,
      assistantId,
    );
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
