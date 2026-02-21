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

const ALLOWED_UPDATES = ["message", "edited_message"];

/**
 * Reconciles the Telegram webhook registration against the expected state
 * derived from the gateway's ingress URL and current webhook secret.
 *
 * If the currently registered webhook URL differs from the expected URL,
 * or if the secret may have changed (we always re-set when the URL matches
 * but we can't verify the secret from getWebhookInfo), the webhook is
 * re-registered via setWebhook.
 *
 * This is safe to call repeatedly; Telegram treats setWebhook as idempotent.
 */
export async function reconcileTelegramWebhook(
  config: GatewayConfig,
  options?: { forceUpdate?: boolean },
): Promise<void> {
  if (!config.telegramBotToken || !config.telegramWebhookSecret) {
    log.debug("Skipping webhook reconciliation: Telegram credentials not configured");
    return;
  }

  if (!config.ingressPublicBaseUrl) {
    log.debug("Skipping webhook reconciliation: INGRESS_PUBLIC_BASE_URL not set");
    return;
  }

  const expectedUrl = `${config.ingressPublicBaseUrl}/webhooks/telegram`;

  const info = await callTelegramApi<WebhookInfo>(config, "getWebhookInfo", {});

  const urlMatches = info.url === expectedUrl;

  // Telegram does not expose the current secret_token via getWebhookInfo,
  // so we cannot compare it directly. When credentials are refreshed
  // (forceUpdate), we always re-set to ensure the secret is current.
  if (urlMatches && !options?.forceUpdate) {
    log.info(
      { currentUrl: info.url, expectedUrl },
      "Telegram webhook URL matches expected state, no update needed",
    );
    return;
  }

  log.info(
    {
      currentUrl: info.url || "(none)",
      expectedUrl,
      forceUpdate: !!options?.forceUpdate,
      urlMatches,
    },
    "Telegram webhook state differs from expected, updating",
  );

  await callTelegramApi(config, "setWebhook", {
    url: expectedUrl,
    secret_token: config.telegramWebhookSecret,
    allowed_updates: ALLOWED_UPDATES,
  });

  log.info({ url: expectedUrl }, "Telegram webhook registered successfully");
}
