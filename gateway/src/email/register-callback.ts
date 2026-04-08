import type { ConfigFileCache } from "../config-file-cache.js";
import type { CredentialCache } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";
import { fetchImpl } from "../fetch.js";
import { getLogger } from "../logger.js";

const log = getLogger("email-callback");

/**
 * The callback path registered with the platform for inbound email webhooks.
 * Must match the gateway route path in index.ts ("/webhooks/email").
 */
export const EMAIL_CALLBACK_PATH = "webhooks/email";
const EMAIL_CALLBACK_TYPE = "email";

interface PlatformCallbackRouteResponse {
  callback_url?: string;
}

/**
 * Register a callback route with the Vellum platform so that inbound email
 * webhooks are forwarded to this gateway instance.
 *
 * Follows the same pattern as Telegram's managed callback route registration
 * in `telegram/webhook-manager.ts`.  Requires platform credentials (base URL,
 * API key, assistant ID) either from the credential cache or environment
 * variables.
 *
 * Self-hosted assistants with a configured ``ingress.publicBaseUrl`` send
 * their own base URL so the callback route points directly at the gateway
 * rather than through the platform proxy.
 *
 * Returns the platform-assigned callback URL on success, or `undefined` if
 * credentials are not available.
 */
export async function registerEmailCallbackRoute(caches?: {
  credentials?: CredentialCache;
  configFile?: ConfigFileCache;
}): Promise<string | undefined> {
  // Read from credential cache when available
  const [platformBaseUrlRaw, assistantApiKeyRaw, assistantIdRaw] =
    caches?.credentials
      ? await Promise.all([
          caches.credentials.get(credentialKey("vellum", "platform_base_url")),
          caches.credentials.get(credentialKey("vellum", "assistant_api_key")),
          caches.credentials.get(
            credentialKey("vellum", "platform_assistant_id"),
          ),
        ])
      : [undefined, undefined, undefined];

  // Fall back to env vars when credential cache values are missing, matching
  // the daemon's resolvePlatformCallbackRegistrationContext() behaviour.
  const platformBaseUrl = (
    platformBaseUrlRaw?.trim() ||
    process.env.VELLUM_PLATFORM_URL?.trim() ||
    ""
  ).replace(/\/+$/, "");

  const platformInternalApiKey =
    process.env.PLATFORM_INTERNAL_API_KEY?.trim() || undefined;
  const assistantApiKey = !platformInternalApiKey
    ? assistantApiKeyRaw?.trim() || undefined
    : undefined;
  const authToken = platformInternalApiKey || assistantApiKey;
  const authScheme = platformInternalApiKey ? "Bearer" : "Api-Key";

  const assistantId =
    process.env.PLATFORM_ASSISTANT_ID?.trim() ||
    assistantIdRaw?.trim() ||
    undefined;

  if (!platformBaseUrl || !authToken || !assistantId) {
    log.debug(
      {
        hasPlatformBaseUrl: !!platformBaseUrl,
        hasApiKey: !!authToken,
        hasAssistantId: !!assistantId,
      },
      "Email callback route registration unavailable — missing credentials",
    );
    return undefined;
  }

  // Self-hosted assistants send their public ingress URL so the platform
  // registers a callback pointing directly at the gateway rather than
  // routing through the platform proxy (matching Telegram's two-tier
  // pattern in telegram/webhook-manager.ts).
  const ingressUrl = caches?.configFile
    ?.getString("ingress", "publicBaseUrl")
    ?.trim()
    .replace(/\/+$/, "");

  const requestBody: Record<string, string> = {
    assistant_id: assistantId,
    callback_path: EMAIL_CALLBACK_PATH,
    type: EMAIL_CALLBACK_TYPE,
  };
  if (ingressUrl) {
    requestBody.callback_base_url = ingressUrl;
  }

  const response = await fetchImpl(
    `${platformBaseUrl}/v1/internal/gateway/callback-routes/register/`,
    {
      method: "POST",
      headers: {
        Authorization: `${authScheme} ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      detail
        ? `Email callback route registration failed (HTTP ${response.status}): ${detail}`
        : `Email callback route registration failed (HTTP ${response.status})`,
    );
  }

  const data = (await response.json()) as PlatformCallbackRouteResponse;
  const callbackUrl = data.callback_url?.trim();
  if (!callbackUrl) {
    throw new Error(
      "Email callback route registration response did not include callback_url",
    );
  }

  log.info({ callbackUrl }, "Email callback route registered with platform");
  return callbackUrl;
}
