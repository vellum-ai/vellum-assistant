import type { CredentialCache } from "../credential-cache.js";
import type { ConfigFileCache } from "../config-file-cache.js";
import { credentialKey } from "../credential-key.js";
import { fetchImpl } from "../fetch.js";
import {
  arePlatformFeaturesEnabled,
  isPlatformMode,
} from "../feature-flag-resolver.js";
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
  if (!arePlatformFeaturesEnabled()) {
    log.debug(
      "Platform features disabled — skipping managed Telegram callback registration",
    );
    return undefined;
  }

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

  // Fall back to env vars when managed pod credentials are not yet cached,
  // matching the daemon's resolvePlatformCallbackRegistrationContext().
  const platformBaseUrl = (
    platformBaseUrlRaw?.trim() ||
    process.env.VELLUM_PLATFORM_URL?.trim() ||
    ""
  ).replace(/\/+$/, "");

  const assistantCredential =
    assistantApiKeyRaw?.trim() ||
    process.env.ASSISTANT_API_KEY?.trim() ||
    undefined;

  const assistantId = assistantIdRaw?.trim() || undefined;

  if (!platformBaseUrl || !assistantCredential || !assistantId) {
    log.debug(
      {
        hasPlatformBaseUrl: !!platformBaseUrl,
        hasApiKey: !!assistantCredential,
        hasAssistantId: !!assistantId,
      },
      "Managed Telegram callback route registration unavailable",
    );
    return undefined;
  }

  // Best-effort: resolve bot username for source_identifier display.
  let sourceIdentifier = "";
  try {
    const botInfo = await callTelegramApi<{ username?: string }>(
      "getMe",
      {},
      caches?.credentials
        ? { credentials: caches.credentials, configFile: caches?.configFile }
        : undefined,
    );
    if (botInfo.username) {
      sourceIdentifier = `@${botInfo.username}`;
    }
  } catch {
    log.debug("Could not resolve Telegram bot username for source_identifier");
  }

  const response = await fetchImpl(
    `${platformBaseUrl}/v1/internal/gateway/callback-routes/register/`,
    {
      method: "POST",
      headers: {
        Authorization: `Api-Key ${assistantCredential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        assistant_id: assistantId,
        callback_path: TELEGRAM_CALLBACK_PATH,
        type: TELEGRAM_CALLBACK_TYPE,
        ...(sourceIdentifier ? { source_identifier: sourceIdentifier } : {}),
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
  // Resolution order mirrors `hasWebhookRoutingConfigured` in
  // assistant/src/config/webhook-routing.ts, which is what the daemon's
  // Telegram config handler and readiness probes report to the user. The two
  // must agree: a mode that derivation reports as configured but this
  // resolver declines makes setup report success while setWebhook never runs
  // (LUM-2899).
  //
  //   1. An explicit `ingress.enabled: false` is a decision not to accept
  //      inbound webhooks at all; it precedes both tiers below and actively
  //      deregisters, so `reconcileTelegramWebhook` handles it before calling
  //      this resolver. Platform pods are exempt (see the comment there).
  //   2. A configured public ingress URL wins (a self-hosted tunnel, or the
  //      Velay-published URL while the tunnel is registered).
  //   3. Platform-connected assistants (platform pods and local assistants
  //      holding vellum credentials) fall back to a managed platform callback
  //      route. `registerManagedTelegramCallbackRoute` self-gates on platform
  //      features and credential presence, so a gateway with no platform
  //      context resolves to undefined and reconciliation skips.
  let ingressUrl: string | undefined;
  if (caches?.configFile) {
    ingressUrl = caches.configFile.getString("ingress", "publicBaseUrl");
  }

  if (ingressUrl) {
    const baseUrl = ingressUrl.replace(/\/+$/, "");
    return `${baseUrl}/${TELEGRAM_CALLBACK_PATH}`;
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

  const apiOpts = caches?.credentials
    ? { credentials: caches.credentials, configFile: caches?.configFile }
    : undefined;

  // An explicit `ingress.enabled: false` must actively deregister, not just
  // skip: Telegram keeps delivering to the last registered webhook URL until
  // deleteWebhook (or a replacement setWebhook) runs, and the gateway's
  // /webhooks/telegram route does not consult this flag. deleteWebhook is
  // idempotent, and pending updates are deliberately kept so re-enabling
  // ingress does not lose queued messages.
  //
  // Platform pods are exempt: `hasWebhookRoutingConfigured` resolves the
  // IS_PLATFORM tier ahead of the explicit-disable check because a pod has no
  // self-owned ingress to disable, so honoring a stray flag here would delete
  // the pod's only delivery path while the daemon still reports the channel
  // as configured (the LUM-2899 divergence in mirror image).
  if (
    !isPlatformMode() &&
    caches?.configFile?.getBoolean("ingress", "enabled") === false
  ) {
    await callTelegramApi("deleteWebhook", {}, apiOpts);
    log.info(
      "Telegram webhook deregistered: public ingress is explicitly disabled",
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
