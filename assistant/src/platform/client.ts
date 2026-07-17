/**
 * Centralized platform API client.
 *
 * Owns managed proxy context resolution, prerequisite validation, and
 * authenticated fetch for all platform API calls.
 */

import { getPlatformAssistantId } from "../config/env.js";
import { resolveManagedProxyContext } from "../providers/platform-proxy/context.js";
import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import { arePlatformFeaturesEnabled } from "./feature-gate.js";

const log = getLogger("platform-client");

let _missingPrereqsWarned = false;

export interface OwnerConsent {
  /**
   * Telemetry is opt-out: the owner-consent endpoint returns effective
   * values (a never-chose null is served as consented), so an explicit
   * `false` is the only thing that disables sharing.
   */
  shareAnalytics: boolean;
  /** Same opt-out semantics as {@link shareAnalytics}. */
  shareDiagnostics: boolean;
  /**
   * Version of the diagnostics-sharing consent the owner accepted
   * ("YYYY-MM-DD", or "" if never accepted). Composes the per-turn
   * trace-collection gate: traces are only collected once this is >= the
   * disclosing version (see telemetry/trace-collection-policy.ts).
   */
  shareDiagnosticsAcceptedVersion: string;
}

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

  /**
   * Fetch the platform owner's telemetry consent for this assistant.
   *
   * The endpoint returns effective consent values (a never-chose null is
   * served as consented); an explicit `false` is the only disable.
   *
   * Returns `null` whenever the consent is unknown — missing assistant id,
   * any non-2xx response, a malformed body, or a network error. Never throws.
   */
  async getOwnerConsent(): Promise<OwnerConsent | null> {
    if (!this.assistantId) {
      return null;
    }

    try {
      const res = await this.fetch(
        `/v1/assistants/${this.assistantId}/owner-consent/`,
      );
      if (!res.ok) {
        log.debug(
          { status: res.status },
          "owner-consent fetch returned non-2xx — treating as unknown",
        );
        return null;
      }

      const body = (await res.json()) as {
        share_analytics?: unknown;
        share_diagnostics?: unknown;
        share_diagnostics_accepted_version?: unknown;
      };
      if (
        (typeof body.share_analytics !== "boolean" &&
          body.share_analytics !== null) ||
        (typeof body.share_diagnostics !== "boolean" &&
          body.share_diagnostics !== null)
      ) {
        log.debug("owner-consent body malformed — treating as unknown");
        return null;
      }

      return {
        // Opt-out: anything but an explicit false enables sharing.
        shareAnalytics: body.share_analytics !== false,
        shareDiagnostics: body.share_diagnostics !== false,
        // Back-compat: an older platform that doesn't return this field yields
        // "" → fails the trace-collection version gate → fail-closed (no trace).
        shareDiagnosticsAcceptedVersion:
          typeof body.share_diagnostics_accepted_version === "string"
            ? body.share_diagnostics_accepted_version
            : "",
      };
    } catch (err) {
      log.debug({ err }, "owner-consent fetch failed — treating as unknown");
      return null;
    }
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
