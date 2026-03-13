import {
  getTwilioCredentials,
  hasTwilioCredentials,
  updatePhoneNumberWebhooks,
} from "../../calls/twilio-rest.js";
import {
  getGatewayInternalBaseUrl,
  setIngressPublicBaseUrl,
} from "../../config/env.js";
import { loadRawConfig, saveRawConfig } from "../../config/loader.js";
import {
  registerCallbackRoute,
  resolveCallbackUrl,
  shouldUsePlatformCallbacks,
} from "../../inbound/platform-callback-registration.js";
import {
  getTwilioStatusCallbackUrl,
  getTwilioVoiceWebhookUrl,
  type IngressConfig,
} from "../../inbound/public-ingress-urls.js";
import type { IngressConfigRequest } from "../message-protocol.js";
import {
  CONFIG_RELOAD_DEBOUNCE_MS,
  type HandlerContext,
  log,
} from "./shared.js";

export function computeGatewayTarget(): string {
  return getGatewayInternalBaseUrl();
}

/**
 * Best-effort Twilio webhook sync helper.
 *
 * Computes the voice and status-callback webhook URLs from the current
 * ingress config and pushes them to the Twilio IncomingPhoneNumber API.
 *
 * Returns `{ success, warning }`. When the update fails, `success` is false
 * and `warning` contains a human-readable message. Callers should treat
 * failure as non-fatal so that the primary operation (provision, assign,
 * ingress save) still succeeds.
 */
export async function syncTwilioWebhooks(
  phoneNumber: string,
  accountSid: string,
  authToken: string,
  ingressConfig: IngressConfig,
): Promise<{ success: boolean; warning?: string }> {
  try {
    const voiceUrl = await resolveCallbackUrl(
      () => getTwilioVoiceWebhookUrl(ingressConfig),
      "webhooks/twilio/voice",
      "twilio_voice",
    );
    const statusCallbackUrl = await resolveCallbackUrl(
      () => getTwilioStatusCallbackUrl(ingressConfig),
      "webhooks/twilio/status",
      "twilio_status",
    );
    await updatePhoneNumberWebhooks(accountSid, authToken, phoneNumber, {
      voiceUrl,
      statusCallbackUrl,
    });
    log.info({ phoneNumber }, "Twilio webhooks configured successfully");
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err, phoneNumber }, `Webhook configuration skipped: ${message}`);
    return {
      success: false,
      warning: `Webhook configuration skipped: ${message}`,
    };
  }
}

export async function handleIngressConfig(
  msg: IngressConfigRequest,
  ctx: HandlerContext,
): Promise<void> {
  const localGatewayTarget = computeGatewayTarget();
  try {
    if (msg.action === "get") {
      const raw = loadRawConfig();
      const ingress = (raw?.ingress ?? {}) as Record<string, unknown>;
      const publicBaseUrl = (ingress.publicBaseUrl as string) ?? "";
      const enabled = (ingress.enabled as boolean | undefined) ?? false;
      ctx.send({
        type: "ingress_config_response",
        enabled,
        publicBaseUrl,
        localGatewayTarget,
        success: true,
      });
    } else if (msg.action === "set") {
      const value = (msg.publicBaseUrl ?? "").trim().replace(/\/+$/, "");
      const raw = loadRawConfig();

      // Update ingress.publicBaseUrl — this is the single source of truth for
      // the canonical public ingress URL. The gateway reads this value from
      // the workspace config file via ConfigFileCache.
      // The gateway also validates Twilio signatures against forwarded public
      // URL headers, so local tunnel updates generally apply without restarts.
      const ingress = (raw?.ingress ?? {}) as Record<string, unknown>;
      ingress.publicBaseUrl = value || undefined;
      if (msg.enabled !== undefined) {
        ingress.enabled = msg.enabled;
      }

      const wasSuppressed = ctx.suppressConfigReload;
      ctx.setSuppressConfigReload(true);
      try {
        saveRawConfig({ ...raw, ingress });
      } catch (err) {
        ctx.setSuppressConfigReload(wasSuppressed);
        throw err;
      }
      ctx.debounceTimers.schedule(
        "__suppress_reset__",
        () => {
          ctx.setSuppressConfigReload(false);
        },
        CONFIG_RELOAD_DEBOUNCE_MS,
      );

      // Propagate to module-level state so the assistant's in-process URL
      // resolution stays in sync. The gateway reads from the workspace config
      // file directly via ConfigFileCache, so no env var propagation is needed.
      // Only set the URL when ingress is enabled; clearing it when
      // disabled ensures the gateway stops accepting inbound webhooks.
      const isEnabled = (ingress.enabled as boolean | undefined) ?? false;
      if (value && isEnabled) {
        setIngressPublicBaseUrl(value);
      } else {
        // Ingress is disabled or no URL is configured — clear the module-level
        // URL so the gateway stops accepting webhooks.
        setIngressPublicBaseUrl(undefined);
      }

      ctx.send({
        type: "ingress_config_response",
        enabled: isEnabled,
        publicBaseUrl: value,
        localGatewayTarget,
        success: true,
      });

      // When containerized with a platform, register the Telegram callback
      // route so the platform knows how to forward Telegram webhooks.
      // This must happen independently of ingress URL — in containerized
      // deployments without ingress.publicBaseUrl, platform callbacks are the
      // only way to receive Telegram webhooks.
      if (shouldUsePlatformCallbacks()) {
        registerCallbackRoute("webhooks/telegram", "telegram").catch((err) => {
          log.warn(
            { err },
            "Failed to register Telegram platform callback route",
          );
        });
      }

      // Best-effort Twilio webhook reconciliation: when ingress is being
      // enabled/updated and Twilio numbers are assigned with valid credentials,
      // push the new webhook URLs to Twilio so calls route correctly.
      if (isEnabled && (await hasTwilioCredentials())) {
        const currentConfig = loadRawConfig();
        const twilioConfig = (currentConfig?.twilio ?? {}) as Record<
          string,
          unknown
        >;
        const assignedNumbers = new Set<string>();
        const primaryNumber = (twilioConfig.phoneNumber as string) ?? "";
        if (primaryNumber) assignedNumbers.add(primaryNumber);

        const assistantPhoneNumbers = twilioConfig.assistantPhoneNumbers;
        if (
          assistantPhoneNumbers &&
          typeof assistantPhoneNumbers === "object" &&
          !Array.isArray(assistantPhoneNumbers)
        ) {
          for (const number of Object.values(
            assistantPhoneNumbers as Record<string, unknown>,
          )) {
            if (typeof number === "string" && number) {
              assignedNumbers.add(number);
            }
          }
        }

        if (assignedNumbers.size > 0) {
          const { accountSid: acctSid, authToken: acctToken } =
            await getTwilioCredentials();
          // Fire-and-forget: webhook sync failure must not block the ingress save.
          // Reconcile every assigned number so assistant-scoped mappings do not
          // retain stale Twilio webhook URLs after ingress URL changes.
          for (const assignedNumber of assignedNumbers) {
            syncTwilioWebhooks(
              assignedNumber,
              acctSid,
              acctToken,
              currentConfig as IngressConfig,
            ).catch(() => {
              // Already logged inside syncTwilioWebhooks
            });
          }
        }
      }
    } else {
      ctx.send({
        type: "ingress_config_response",
        enabled: false,
        publicBaseUrl: "",
        localGatewayTarget,
        success: false,
        error: `Unknown action: ${String(msg.action)}`,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.send({
      type: "ingress_config_response",
      enabled: false,
      publicBaseUrl: "",
      localGatewayTarget,
      success: false,
      error: message,
    });
  }
}
