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
import { ipcRegisterWebhookRoute } from "../ipc/gateway-client.js";
import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import { PublicIngressDisabledError } from "./public-ingress-urls.js";
import { isVelayWebhooksEnabled } from "./velay-webhooks-gate.js";

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
 * Claim a webhook subpath on the gateway so the Velay tunnel forwards it.
 *
 * The registry matches paths exactly, so query parameters a caller appends to
 * the resolved URL play no part. Returns false when the gateway declines the
 * claim or cannot be reached, leaving platform callback registration as the
 * way to keep the webhook reachable.
 *
 * @param callbackPath - The path to claim, e.g. "webhooks/twilio/voice".
 */
export async function registerLocalWebhookRoute(
  callbackPath: string,
  type: string,
  sourceIdentifier?: string,
): Promise<boolean> {
  const path = callbackPath.startsWith("/") ? callbackPath : `/${callbackPath}`;
  const result = await ipcRegisterWebhookRoute({
    path,
    type,
    source: sourceIdentifier,
  });

  if (!result.ok) {
    log.warn(
      { path, type, reason: result.reason },
      "Gateway webhook route registration failed, falling back to the platform",
    );
    return false;
  }
  if (result.disabled) {
    log.info(
      { path, type },
      "Gateway is not serving its own webhooks, falling back to the platform",
    );
    return false;
  }

  log.debug({ path, type }, "Gateway webhook route registered");
  return true;
}

/**
 * Resolve a callback URL, registering with the platform when appropriate.
 *
 * Resolution order, matching `handleWebhooksRegister` in
 * `runtime/routes/webhook-routes.ts` and `hasWebhookRoutingConfigured` in
 * `config/webhook-routing.ts`:
 *
 *   1. **Platform pods** (`IS_PLATFORM`) with the `velay-webhooks` flag off
 *      always register with the platform gateway. With the flag on, they try
 *      the direct supplier first — the gateway's Velay client publishes the
 *      tunnel URL into `ingress.publicBaseUrl` — and fall back to platform
 *      registration on any failure, including an explicit
 *      `ingress.enabled: false`: a pod owner toggling that flag must not
 *      lose webhooks entirely. The subpath is claimed on the gateway before
 *      the tunnel URL is handed out, and a refused claim falls back the same
 *      way.
 *   2. **A configured public ingress wins** for everyone else, so the direct
 *      supplier is tried first and its value returned when it resolves.
 *   3. **Platform-connected assistants with no ingress** register with the
 *      platform gateway rather than surfacing the direct builder's error.
 *      Connectivity is decided by credentials (platform base URL + assistant
 *      ID + assistant API key), not by `IS_PLATFORM`, which is only ever true
 *      on a platform pod.
 *
 * Off a pod, an explicit `ingress.enabled: false` is a decision not to accept
 * inbound webhooks at all, so `PublicIngressDisabledError` propagates instead
 * of being routed around. Ingress precedes the platform fallback because any
 * logged-in local assistant holds platform credentials for the LLM proxy:
 * treating credential presence as "managed" would silently reroute an
 * explicitly configured self-hosted callback through the platform.
 *
 * The `directUrl` parameter is a **lazy supplier** (a function returning a
 * string) rather than an eagerly-evaluated string. This is critical because
 * the direct URL builders (e.g. `getTwilioVoiceWebhookUrl`) call
 * `getPublicBaseUrl()` which throws when no public ingress URL is configured.
 * On a platform pod the direct URL is never needed, and deferring evaluation
 * avoids the throw.
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
  const isPlatform = getIsPlatform();
  if (!isPlatform || isVelayWebhooksEnabled()) {
    let ingressUrl: string | undefined;
    let ingressError: unknown;
    try {
      ingressUrl = directUrl();
    } catch (err) {
      if (err instanceof PublicIngressDisabledError && !isPlatform) {
        throw err;
      }
      ingressError = err;
    }

    if (ingressUrl !== undefined) {
      // A pod's tunnel only forwards subpaths the gateway has claimed, so the
      // URL is handed out only once the claim succeeds.
      if (
        !isPlatform ||
        (await registerLocalWebhookRoute(callbackPath, type, sourceIdentifier))
      ) {
        return ingressUrl;
      }
    } else if (!isPlatform) {
      // No ingress configured. Fall back to the platform gateway when this
      // assistant is connected to the platform. Platform pods always are, so
      // they skip the context probe and register directly.
      const context = await resolvePlatformCallbackRegistrationContext();
      if (!context.enabled) {
        throw ingressError;
      }
    }
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
    // Registration is only attempted once the local ingress has been ruled
    // out, so there is nothing left to fall back to. Surface a clear error so
    // callers (and the user) understand this is a platform-side issue, not a
    // tunnel problem.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Managed callback route registration failed: ${detail}. ` +
        `Please contact support if this problem persists.`,
    );
  }
}
