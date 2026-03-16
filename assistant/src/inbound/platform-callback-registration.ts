/**
 * Platform callback route registration for containerized deployments.
 *
 * When the assistant daemon runs inside a container (IS_CONTAINERIZED=true)
 * with a configured PLATFORM_BASE_URL and PLATFORM_ASSISTANT_ID, external
 * service callbacks (Twilio webhooks, OAuth redirects, Telegram webhooks, etc.)
 * must route through the platform's gateway proxy instead of hitting the
 * assistant directly.
 *
 * This module registers callback routes with the platform's internal
 * gateway endpoint so the platform knows how to forward inbound provider
 * webhooks to the correct containerized assistant instance.
 *
 * The platform endpoint is:
 *   POST {PLATFORM_BASE_URL}/v1/internal/gateway/callback-routes/register/
 *
 * It accepts { assistant_id, callback_path, type } and returns a stable
 * callback_url that external services should use.
 */

import {
  getPlatformAssistantId,
  getPlatformBaseUrl,
  getPlatformInternalApiKey,
} from "../config/env.js";
import { getIsContainerized } from "../config/env-registry.js";
import { isManagedProxyEnabledSync } from "../providers/managed-proxy/context.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("platform-callback-registration");

/**
 * Whether this is a platform-managed deployment with usable managed credentials.
 *
 * True when PLATFORM_BASE_URL and PLATFORM_ASSISTANT_ID are both set **and**
 * the managed proxy prerequisites (including the assistant API key) were
 * satisfied the last time `resolveManagedProxyContext()` ran. This prevents
 * the system prompt from claiming managed credentials are available during
 * partial/failed platform bootstrap where the API key is missing.
 */
export function isPlatformManaged(): boolean {
  return (
    !!getPlatformBaseUrl() &&
    !!getPlatformAssistantId() &&
    isManagedProxyEnabledSync()
  );
}

/**
 * Whether the daemon should register callback routes with the platform.
 * True when IS_CONTAINERIZED, PLATFORM_BASE_URL, and PLATFORM_ASSISTANT_ID
 * are all set.
 */
export function shouldUsePlatformCallbacks(): boolean {
  return getIsContainerized() && isPlatformManaged();
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
 * @returns The platform-provided callback URL that external services should use.
 * @throws If the platform request fails.
 */
export async function registerCallbackRoute(
  callbackPath: string,
  type: string,
): Promise<string> {
  const platformBaseUrl = getPlatformBaseUrl().replace(/\/+$/, "");
  const assistantId = getPlatformAssistantId();
  const apiKey = getPlatformInternalApiKey();

  const url = `${platformBaseUrl}/v1/internal/gateway/callback-routes/register/`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const body = JSON.stringify({
    assistant_id: assistantId,
    callback_path: callbackPath,
    type,
  });

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
 * Resolve a callback URL, registering with the platform when containerized.
 *
 * When platform callbacks are enabled, registers the route and returns the
 * platform's stable callback URL (optionally with query parameters appended).
 * Otherwise evaluates the lazy direct URL supplier and returns that value.
 *
 * The `directUrl` parameter is a **lazy supplier** (a function returning a
 * string) rather than an eagerly-evaluated string. This is critical because
 * the direct URL builders (e.g. `getTwilioVoiceWebhookUrl`) call
 * `getPublicBaseUrl()` which throws when no public ingress URL is configured.
 * In containerized environments that rely solely on platform callbacks, the
 * direct URL is never needed — deferring evaluation avoids the throw.
 *
 * @param directUrl - Lazy supplier for the direct callback URL.
 * @param callbackPath - The path to register (e.g. "webhooks/twilio/voice").
 * @param type - The route type identifier.
 * @param queryParams - Optional query parameters to append to the resolved URL.
 * @returns The resolved callback URL.
 */
export async function resolveCallbackUrl(
  directUrl: () => string,
  callbackPath: string,
  type: string,
  queryParams?: Record<string, string>,
): Promise<string> {
  if (!shouldUsePlatformCallbacks()) {
    return directUrl();
  }

  try {
    let url = await registerCallbackRoute(callbackPath, type);
    if (queryParams && Object.keys(queryParams).length > 0) {
      const params = new URLSearchParams(queryParams);
      const separator = url.includes("?") ? "&" : "?";
      url = `${url}${separator}${params.toString()}`;
    }
    return url;
  } catch (err) {
    log.warn(
      { err, callbackPath, type },
      "Failed to register platform callback route, falling back to direct URL",
    );
    try {
      return directUrl();
    } catch (fallbackErr) {
      log.error(
        { fallbackErr, callbackPath, type },
        "Direct URL fallback also failed after platform registration failure",
      );
      throw err;
    }
  }
}
