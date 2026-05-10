/**
 * Platform callback route registration.
 *
 * Both platform-managed (IS_PLATFORM=true) and self-hosted assistants can
 * register callback routes with the platform so inbound provider webhooks
 * (Telegram, Twilio, email, OAuth) are forwarded correctly.
 *
 * Platform-managed assistants pick up context from environment variables.
 * Self-hosted assistants use stored credentials (from `assistant platform
 * connect` or the ensure-registration bootstrap).
 *
 * The platform endpoint is:
 *   POST {VELLUM_PLATFORM_URL}/v1/internal/gateway/callback-routes/register/
 *
 * It accepts { assistant_id, callback_path, type } and returns a stable
 * callback_url that external services should use.
 */

import { getPlatformAssistantId, getPlatformBaseUrl } from "../config/env.js";
import { getIsPlatform } from "../config/env-registry.js";
import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("platform-callback-registration");

export interface PlatformCallbackRegistrationContext {
  isPlatform: boolean;
  platformBaseUrl: string;
  assistantId: string;
  hasAssistantApiKey: boolean;
  authHeader: string | null;
  enabled: boolean;
}

export async function resolvePlatformCallbackRegistrationContext(): Promise<PlatformCallbackRegistrationContext> {
  const platform = getIsPlatform();
  const [storedBaseUrlRaw, storedAssistantIdRaw, storedAssistantApiKeyRaw] =
    await Promise.all([
      getSecureKeyAsync(credentialKey("vellum", "platform_base_url")),
      getSecureKeyAsync(credentialKey("vellum", "platform_assistant_id")),
      getSecureKeyAsync(credentialKey("vellum", "assistant_api_key")),
    ]);

  const storedBaseUrl = storedBaseUrlRaw?.trim();
  const platformBaseUrl = (storedBaseUrl || getPlatformBaseUrl()).replace(
    /\/+$/,
    "",
  );
  const assistantId =
    getPlatformAssistantId().trim() || storedAssistantIdRaw?.trim() || "";
  const envAssistantCredential = process.env.ASSISTANT_API_KEY?.trim();
  const assistantCredential =
    storedAssistantApiKeyRaw?.trim() || envAssistantCredential || undefined;
  const authHeader = assistantCredential
    ? `Api-Key ${assistantCredential}`
    : null;

  return {
    isPlatform: platform,
    platformBaseUrl,
    assistantId,
    hasAssistantApiKey: !!assistantCredential,
    authHeader,
    // Enabled when we have enough context to register callback routes.
    // Does NOT require IS_PLATFORM — self-hosted assistants with stored
    // credentials can also register routes.
    enabled:
      platformBaseUrl.length > 0 &&
      assistantId.length > 0 &&
      authHeader !== null,
  };
}

interface RegisterCallbackRouteResponse {
  callback_url: string;
  callback_path: string;
  type: string;
  assistant_id: string;
}

/**
 * Register a callback route with the platform's internal gateway endpoint.
 *
 * @param callbackPath - The path portion after the ingress base URL
 *   (e.g. "webhooks/twilio/voice"). Leading/trailing slashes are stripped
 *   by the platform.
 * @param type - The route type identifier (e.g. "twilio_voice",
 *   "twilio_status", "oauth", "telegram").
 * @param sourceIdentifier - Optional human-readable source identifier
 *   (e.g. bot handle, phone number) for display in admin UI.
 * @returns The platform-provided callback URL that external services should use.
 * @throws If the platform request fails.
 */
export async function registerCallbackRoute(
  callbackPath: string,
  type: string,
  sourceIdentifier?: string,
): Promise<string> {
  const context = await resolvePlatformCallbackRegistrationContext();
  if (!context.enabled || !context.authHeader) {
    throw new Error(
      "Platform callbacks not available — missing platform registration context",
    );
  }

  const platformBaseUrl = context.platformBaseUrl;
  const assistantId = context.assistantId;

  const url = `${platformBaseUrl}/v1/internal/gateway/callback-routes/register/`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: context.authHeader,
  };

  const payload: Record<string, string> = {
    assistant_id: assistantId,
    callback_path: callbackPath,
    type,
  };
  if (sourceIdentifier) {
    payload.source_identifier = sourceIdentifier;
  }
  const body = JSON.stringify(payload);

  log.debug({ callbackPath, type }, "Registering platform callback route");

  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Platform callback route registration failed (HTTP ${response.status}): ${detail}`,
    );
  }

  const data = (await response.json()) as RegisterCallbackRouteResponse;

  log.info(
    { callbackPath, type, callbackUrl: data.callback_url },
    "Platform callback route registered",
  );

  return data.callback_url;
}

/**
 * Resolve a callback URL, registering with the platform when platform-managed.
 *
 * When platform callbacks are enabled, registers the route and returns the
 * platform's stable callback URL (optionally with query parameters appended).
 * Otherwise evaluates the lazy direct URL supplier and returns that value.
 *
 * The `directUrl` parameter is a **lazy supplier** (a function returning a
 * string) rather than an eagerly-evaluated string. This is critical because
 * the direct URL builders (e.g. `getTwilioVoiceWebhookUrl`) call
 * `getPublicBaseUrl()` which throws when no public ingress URL is configured.
 * In platform-managed environments that rely solely on platform callbacks, the
 * direct URL is never needed — deferring evaluation avoids the throw.
 *
 * @param directUrl - Lazy supplier for the direct callback URL.
 * @param callbackPath - The path to register (e.g. "webhooks/twilio/voice").
 * @param type - The route type identifier.
 * @param queryParams - Optional query parameters to append to the resolved URL.
 * @param sourceIdentifier - Optional human-readable source identifier for admin display.
 * @returns The resolved callback URL.
 */
export async function resolveCallbackUrl(
  directUrl: () => string,
  callbackPath: string,
  type: string,
  queryParams?: Record<string, string>,
  sourceIdentifier?: string,
): Promise<string> {
  if (!getIsPlatform()) {
    return directUrl();
  }

  try {
    let url = await registerCallbackRoute(callbackPath, type, sourceIdentifier);
    if (queryParams && Object.keys(queryParams).length > 0) {
      const params = new URLSearchParams(queryParams);
      const separator = url.includes("?") ? "&" : "?";
      url = `${url}${separator}${params.toString()}`;
    }
    return url;
  } catch (err) {
    // In platform-managed mode there is no local-ingress fallback and
    // ngrok is not applicable. Surface a clear error so callers (and the
    // user) understand this is a platform-side issue, not a tunnel problem.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Managed callback route registration failed: ${detail}. ` +
        `Please contact support if this problem persists.`,
    );
  }
}
