import type { CredentialCache } from "../credential-cache.js";
import type { ConfigFileCache } from "../config-file-cache.js";
import type { GatewayConfig } from "../config.js";
import { callTelegramApi } from "./api.js";
import { getLogger } from "../logger.js";

const log = getLogger("webhook-manager");

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

/**
 * Reconciles the Telegram webhook registration against the expected state
 * derived from the gateway's ingress URL and current webhook secret.
 *
 * Always calls setWebhook because Telegram does not expose the current
 * secret_token via getWebhookInfo — a secret rotation with an unchanged URL
 * would be invisible to us, causing all deliveries to fail with 401.
 * setWebhook is idempotent, so calling it unconditionally is safe.
 */
export async function reconcileTelegramWebhook(
  config: GatewayConfig,
  caches?: WebhookManagerCaches,
): Promise<void> {
  // Resolve credentials — prefer cache, fall back to config
  let botToken: string | undefined;
  let webhookSecret: string | undefined;
  if (caches?.credentials) {
    botToken = await caches.credentials.get("credential:telegram:bot_token");
    webhookSecret = await caches.credentials.get(
      "credential:telegram:webhook_secret",
    );
  }
  botToken ??= config.telegramBotToken;
  webhookSecret ??= config.telegramWebhookSecret;

  if (!botToken || !webhookSecret) {
    log.debug(
      "Skipping webhook reconciliation: Telegram credentials not configured",
    );
    return;
  }

  // Resolve ingress URL — prefer cache, fall back to config
  let ingressUrl: string | undefined;
  if (caches?.configFile) {
    ingressUrl = caches.configFile.getString("ingress", "publicBaseUrl");
  }
  ingressUrl ??= config.ingressPublicBaseUrl;

  if (!ingressUrl) {
    log.debug(
      "Skipping webhook reconciliation: INGRESS_PUBLIC_BASE_URL not set",
    );
    return;
  }

  // Strip trailing slashes to avoid double-slash in the path
  // (e.g. "https://example.com/" + "/webhooks/telegram" => "https://example.com//webhooks/telegram")
  const baseUrl = ingressUrl.replace(/\/+$/, "");
  const expectedUrl = `${baseUrl}/webhooks/telegram`;

  const info = await callTelegramApi<WebhookInfo>(
    config,
    "getWebhookInfo",
    {},
    caches?.credentials ? { credentials: caches.credentials } : undefined,
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
    config,
    "setWebhook",
    {
      url: expectedUrl,
      secret_token: webhookSecret,
      allowed_updates: ALLOWED_UPDATES,
    },
    caches?.credentials ? { credentials: caches.credentials } : undefined,
  );

  log.info({ url: expectedUrl }, "Telegram webhook registered successfully");
}
