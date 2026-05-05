import { updatePhoneNumberWebhooks } from "../../calls/twilio-rest.js";
import {
  getGatewayInternalBaseUrl,
  getPlatformAssistantId,
  getPlatformBaseUrl,
} from "../../config/env.js";
import { getIsPlatform } from "../../config/env-registry.js";
import { loadRawConfig } from "../../config/loader.js";
import { resolveCallbackUrl } from "../../inbound/platform-callback-registration.js";
import {
  getTwilioStatusCallbackUrl,
  getTwilioVoiceWebhookUrl,
  type IngressConfig,
} from "../../inbound/public-ingress-urls.js";
import { log } from "./shared.js";

export function computeGatewayTarget(): string {
  return getGatewayInternalBaseUrl();
}

/**
 * Read the current ingress config from the raw workspace config file.
 * Extracted so it can be called from both the daemon message handler
 * and the HTTP route handler.
 */
export function getIngressConfigResult(): {
  enabled: boolean;
  publicBaseUrl: string;
  localGatewayTarget: string;
  managedCallbacks: boolean;
  success: boolean;
} {
  // Platform-managed assistants don't configure ingress.publicBaseUrl —
  // they receive webhooks through platform callback routing. Surface the
  // platform callback URL and flag managedCallbacks so consumers (including
  // the assistant LLM) don't mistakenly try to set up ngrok or a tunnel.
  if (getIsPlatform()) {
    const platformBase = getPlatformBaseUrl().replace(/\/+$/, "");
    const assistantId = getPlatformAssistantId();
    if (assistantId) {
      return {
        enabled: true,
        publicBaseUrl: `${platformBase}/gateway/callbacks/${assistantId}`,
        localGatewayTarget: computeGatewayTarget(),
        managedCallbacks: true,
        success: true,
      };
    }
  }

  const raw = loadRawConfig();
  const ingress = (raw?.ingress ?? {}) as Record<string, unknown>;
  const publicBaseUrl = (ingress.publicBaseUrl as string) ?? "";
  const enabled = (ingress.enabled as boolean | undefined) ?? false;
  return {
    enabled,
    publicBaseUrl,
    localGatewayTarget: computeGatewayTarget(),
    managedCallbacks: false,
    success: true,
  };
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
