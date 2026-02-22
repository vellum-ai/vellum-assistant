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
): Promise<void> {
  if (!config.telegramBotToken || !config.telegramWebhookSecret) {
    log.debug("Skipping webhook reconciliation: Telegram credentials not configured");
    return;
  }

  if (!config.ingressPublicBaseUrl) {
    log.debug("Skipping webhook reconciliation: INGRESS_PUBLIC_BASE_URL not set");
    return;
  }

  // Strip trailing slashes to avoid double-slash in the path
  // (e.g. "https://example.com/" + "/webhooks/telegram" => "https://example.com//webhooks/telegram")
  const baseUrl = config.ingressPublicBaseUrl.replace(/\/+$/, "");
  const expectedUrl = `${baseUrl}/webhooks/telegram`;

  const info = await callTelegramApi<WebhookInfo>(config, "getWebhookInfo", {});

  log.info(
    {
      currentUrl: info.url || "(none)",
      expectedUrl,
      urlMatches: info.url === expectedUrl,
    },
    "Reconciling Telegram webhook",
  );

  await callTelegramApi(config, "setWebhook", {
    url: expectedUrl,
    secret_token: config.telegramWebhookSecret,
    allowed_updates: ALLOWED_UPDATES,
  });

  log.info({ url: expectedUrl }, "Telegram webhook registered successfully");
}
