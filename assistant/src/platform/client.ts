/**
 * Centralized platform API client.
 *
 * Owns managed proxy context resolution, prerequisite validation, and
 * authenticated fetch for all platform API calls.
 */

import { getPlatformAssistantId } from "../config/env.js";
import { resolveManagedProxyContext } from "../providers/platform-proxy/context.js";
import { credentialKey } from "../security/credential-key.js";
import {
  getSecureKeyAsync,
  getSecureKeyResultAsync,
} from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import { arePlatformFeaturesEnabled } from "./feature-gate.js";

const log = getLogger("platform-client");

let _missingPrereqsWarned = false;

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
    if (!arePlatformFeaturesEnabled()) {
      log.debug("platform features disabled — returning null");
      return null;
    }

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
      const level = _missingPrereqsWarned ? "debug" : "warn";
      _missingPrereqsWarned = true;
      log[level](
        {
          hasBaseUrl: !!baseUrl,
          hasApiKey: !!apiKey,
          hasAssistantId: !!assistantId,
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

/**
 * Why `VellumPlatformClient.create()` returned null, for callers that must
 * distinguish a genuinely off-platform install from a transient credential
 * read failure.
 *
 * - `"absent"`: the credential read succeeded and returned nothing — the
 *   install is genuinely off-platform.
 * - `"unreachable"`: the credential backend could not be read (transient), OR
 *   the credential is present but the client is still unavailable, OR the read
 *   threw. Callers should treat all of these as transient and preserve
 *   whatever local state they hold rather than pruning it.
 */
export type PlatformCredentialAvailability = "absent" | "unreachable";

/**
 * Classify whether platform credentials are genuinely absent or merely
 * unreadable, for callers (e.g. managed-profiles) that must distinguish a
 * genuinely off-platform install from a transient credential-backend failure.
 *
 * Re-reads the assistant API key (the same credential `create()` requires) via
 * `getSecureKeyResultAsync`, which surfaces a distinct `unreachable` signal.
 * Only an explicit "read succeeded, value absent" yields `"absent"`. An
 * unreachable read, a present-but-unusable key, or any thrown read error all
 * yield `"unreachable"` — when in doubt we prefer preservation.
 *
 * Note: this does NOT check `arePlatformFeaturesEnabled()` — callers that need
 * the "features disabled" short-circuit should check it before calling this.
 */
export async function classifyMissingPlatformCredential(): Promise<PlatformCredentialAvailability> {
  try {
    const apiKey = await getSecureKeyResultAsync(
      credentialKey("vellum", "assistant_api_key"),
    );
    if (apiKey.unreachable) {
      // Credential backend could not be reached — transient.
      log.warn(
        "Platform features enabled but assistant API key unreadable (backend unreachable) — treating as transient",
      );
      return "unreachable";
    }
    if (!apiKey.value) {
      // Read succeeded and the credential is genuinely absent — off-platform.
      return "absent";
    }
    // The key exists but `create()` still returned null (e.g. base URL
    // missing or another transient gap). Prefer the safe classification.
    log.warn(
      "Platform features enabled and assistant API key present but client unavailable — treating as transient",
    );
    return "unreachable";
  } catch (err) {
    // A thrown credential read is a transient/unreachable condition.
    log.warn(
      { err },
      "Failed to read platform credentials while classifying missing client — treating as transient",
    );
    return "unreachable";
  }
}
