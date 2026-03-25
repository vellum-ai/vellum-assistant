import type { CredentialCache } from "../credential-cache.js";
import type { ConfigFileCache } from "../config-file-cache.js";
import { credentialKey } from "../credential-key.js";
import { fetchImpl } from "../fetch.js";
import { callTelegramApi } from "./api.js";
import { getLogger } from "../logger.js";

const log = getLogger("webhook-manager");
const TELEGRAM_CALLBACK_PATH = "webhooks/telegram";
const TELEGRAM_CALLBACK_TYPE = "telegram";

interface WebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  /** Telegram does not return the secret itself, but we can detect a mismatch by re-setting. */
}

const ALLOWED_UPDATES = ["message", "edited_message", "callback_query"];

/** Options bag for optional cache injection into webhook reconciliation. */
export type WebhookManagerCaches = {
  credentials?: CredentialCache;
  configFile?: ConfigFileCache;
};

interface PlatformCallbackRouteResponse {
  callback_url?: string;
}

async function registerManagedTelegramCallbackRoute(
  caches?: WebhookManagerCaches,
): Promise<string | undefined> {
  if (!caches?.credentials) return undefined;

  const [platformBaseUrlRaw, assistantApiKeyRaw, assistantIdRaw] =
    await Promise.all([
      caches.credentials.get(credentialKey("vellum", "platform_base_url")),
      caches.credentials.get(credentialKey("vellum", "assistant_api_key")),
      caches.credentials.get(credentialKey("vellum", "platform_assistant_id")),
    ]);

  const platformBaseUrl = platformBaseUrlRaw?.trim().replace(/\/+$/, "");
  const assistantApiKey = assistantApiKeyRaw?.trim();
  const assistantId = assistantIdRaw?.trim();

  if (!platformBaseUrl || !assistantApiKey || !assistantId) {
    log.debug(
      {
        hasPlatformBaseUrl: !!platformBaseUrl,
        hasAssistantApiKey: !!assistantApiKey,
        hasAssistantId: !!assistantId,
      },
      "Managed Telegram callback route registration unavailable",
    );
    return undefined;
  }

  const response = await fetchImpl(
    `${platformBaseUrl}/v1/internal/gateway/callback-routes/register/`,
    {
      method: "POST",
      headers: {
        Authorization: `Api-Key ${assistantApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        assistant_id: assistantId,
        callback_path: TELEGRAM_CALLBACK_PATH,
        type: TELEGRAM_CALLBACK_TYPE,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      detail
        ? `Platform callback route registration failed (HTTP ${response.status}): ${detail}`
        : `Platform callback route registration failed (HTTP ${response.status})`,
    );
  }

  const data = (await response.json()) as PlatformCallbackRouteResponse;
  const callbackUrl = data.callback_url?.trim();
  if (!callbackUrl) {
    throw new Error(
      "Platform callback route registration response did not include callback_url",
    );
  }

  return callbackUrl;
}

async function resolveExpectedTelegramWebhookUrl(
  caches?: WebhookManagerCaches,
): Promise<string | undefined> {
  let ingressUrl: string | undefined;
  if (caches?.configFile) {
    ingressUrl = caches.configFile.getString("ingress", "publicBaseUrl");
  }

  if (ingressUrl) {
    const baseUrl = ingressUrl.replace(/\/+$/, "");
    return `${baseUrl}/${TELEGRAM_CALLBACK_PATH}`;
  }

  // Only fall back to managed callback registration in containerized mode.
  // A local gateway that happens to have stored vellum credentials should not
  // silently reroute Telegram webhooks to the platform.
  if (!process.env.IS_CONTAINERIZED) {
    return undefined;
  }

  return registerManagedTelegramCallbackRoute(caches);
}

/**
 * Reconciles the Telegram webhook registration against the expected state
 * derived from the configured public ingress URL or managed platform callback
 * route, plus the current webhook secret.
 *
 * Always calls setWebhook because Telegram does not expose the current
 * secret_token via getWebhookInfo — a secret rotation with an unchanged URL
 * would be invisible to us, causing all deliveries to fail with 401.
 * setWebhook is idempotent, so calling it unconditionally is safe.
 */
export async function reconcileTelegramWebhook(
  caches?: WebhookManagerCaches,
): Promise<void> {
  // Resolve credentials from cache
  let botToken: string | undefined;
  let webhookSecret: string | undefined;
  if (caches?.credentials) {
    botToken = await caches.credentials.get(
      credentialKey("telegram", "bot_token"),
    );
    webhookSecret = await caches.credentials.get(
      credentialKey("telegram", "webhook_secret"),
    );
  }

  if (!botToken || !webhookSecret) {
    log.debug(
      "Skipping webhook reconciliation: Telegram credentials not configured",
    );
    return;
  }

  let expectedUrl: string | undefined;
  try {
    expectedUrl = await resolveExpectedTelegramWebhookUrl(caches);
  } catch (err) {
    // Managed callback route registration failed — this is a platform-side
    // issue. Do not suggest ngrok or other tunnel options; they are not
    // usable in containerized deployments.
    const detail = err instanceof Error ? err.message : String(err);
    log.error(
      { err },
      `Telegram webhook registration failed: managed platform callback route could not be registered. ` +
        `Please contact support. (${detail})`,
    );
    return;
  }
  if (!expectedUrl) {
    log.debug(
      "Skipping webhook reconciliation: no public ingress or managed callback route available",
    );
    return;
  }

  const apiOpts = caches?.credentials
    ? { credentials: caches.credentials, configFile: caches?.configFile }
    : undefined;

  const info = await callTelegramApi<WebhookInfo>(
    "getWebhookInfo",
    {},
    apiOpts,
  );

  log.info(
    {
      currentUrl: info.url || "(none)",
      expectedUrl,
      urlMatches: info.url === expectedUrl,
    },
    "Reconciling Telegram webhook",
  );

  await callTelegramApi(
    "setWebhook",
    {
      url: expectedUrl,
      secret_token: webhookSecret,
      allowed_updates: ALLOWED_UPDATES,
    },
    apiOpts,
  );

  log.info({ url: expectedUrl }, "Telegram webhook registered successfully");
}
