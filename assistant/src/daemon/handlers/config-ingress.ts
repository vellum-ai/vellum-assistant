import {
  INGRESS_ASSISTANT_ID_KEY,
  INGRESS_LAST_TUNNEL_KEY,
  INGRESS_PAIRING_TUNNEL_KEY,
  normalizePublicBaseUrl,
  parseRecordedAssistantId,
  parseTunnelRecord,
  type TunnelRecord,
} from "@vellumai/service-contracts/ingress";

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
  isPublicIngressDisabled,
} from "../../inbound/public-ingress-urls.js";
import { isPlainObject } from "../../util/object.js";
import { log } from "./shared.js";

export function computeGatewayTarget(): string {
  return getGatewayInternalBaseUrl();
}

/**
 * The `ingress` section of the raw workspace config.
 *
 * `vellum tunnel` writes this section (`cli/src/lib/ingress-config.ts`). The
 * CLI is a separate build unit the assistant does not depend on, so the key
 * names and the record validation are shared through
 * `@vellumai/service-contracts/ingress` instead.
 */
function readIngressSection(): Record<string, unknown> {
  const ingress = loadRawConfig().ingress;
  return isPlainObject(ingress) ? ingress : {};
}

/** Read the last tunnel that ran, or null when it is absent or malformed. */
export function loadLastTunnelRecord(): TunnelRecord | null {
  return parseTunnelRecord(readIngressSection()[INGRESS_LAST_TUNNEL_KEY]);
}

/**
 * Read the tunnel published for device pairing alone, or null when it is
 * absent or malformed.
 *
 * A tailnet-only tunnel started beside configured webhook integrations records
 * itself here instead of replacing `publicBaseUrl`, which those callbacks need
 * to keep resolving to an address their callers can reach.
 */
export function loadPairingTunnelRecord(): TunnelRecord | null {
  return parseTunnelRecord(readIngressSection()[INGRESS_PAIRING_TUNNEL_KEY]);
}

/**
 * Read the assistant id the last tunnel fronted, or null when absent. The
 * daemon cannot derive it: it scopes itself as `self` internally.
 */
export function loadRecordedAssistantId(): string | null {
  return parseRecordedAssistantId(
    readIngressSection()[INGRESS_ASSISTANT_ID_KEY],
  );
}

/** Key under `ingress` naming the component that owns `publicBaseUrl`. */
const INGRESS_MANAGED_BY_KEY = "publicBaseUrlManagedBy";

/** Value that key carries when a self-hosted gateway's Velay tunnel owns it. */
const VELAY_MANAGED_BY = "velay";

/**
 * True when Velay owns `ingress.publicBaseUrl`.
 *
 * A gateway started with `VELAY_BASE_URL` writes the URL when its tunnel comes
 * up, clears it when the tunnel drops, and reconnects on its own
 * (`gateway/src/velay/client.ts`). Readers must not offer the user a tunnel
 * command for an ingress they do not own.
 */
export function isVelayManagedIngress(): boolean {
  return readIngressSection()[INGRESS_MANAGED_BY_KEY] === VELAY_MANAGED_BY;
}

/**
 * Drop `ingress.assistantId`, `ingress.lastTunnel` and `ingress.pairingTunnel`
 * from `ingress` when `nextPublicBaseUrl` replaces a different address,
 * mutating it in place.
 *
 * The first two describe the address being replaced, so keeping them makes the
 * status route call a legitimate retarget `foreign` and name a tunnel that
 * never fronted the new address. The pairing record goes with them because it
 * outranks `publicBaseUrl` where the status route reports an address: a
 * leftover one would hide the address the user just set behind a tunnel they
 * are no longer running. Every writer of `ingress.publicBaseUrl` owes this
 * cleanup, so it lives here rather than in each of them. An absent `ingress`
 * section carries no records to drop.
 */
export function dropTunnelRecordsForNewUrl(
  ingress: Record<string, unknown> | undefined,
  nextPublicBaseUrl: unknown,
): void {
  if (!ingress) {
    return;
  }
  if (
    normalizePublicBaseUrl(nextPublicBaseUrl) ===
    normalizePublicBaseUrl(ingress.publicBaseUrl)
  ) {
    return;
  }
  delete ingress[INGRESS_ASSISTANT_ID_KEY];
  delete ingress[INGRESS_LAST_TUNNEL_KEY];
  delete ingress[INGRESS_PAIRING_TUNNEL_KEY];
}

/**
 * Read the current ingress config from the raw workspace config file.
 * Extracted so it can be called from both the daemon message handler
 * and the HTTP route handler.
 */
export function getIngressConfigResult(): {
  enabled: boolean;
  explicitlyDisabled: boolean;
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
        explicitlyDisabled: false,
        publicBaseUrl: `${platformBase}/gateway/callbacks/${assistantId}`,
        localGatewayTarget: computeGatewayTarget(),
        managedCallbacks: true,
        success: true,
      };
    }
  }

  const ingress = readIngressSection();
  // Typed reads, not casts: a hand-edited config must not hand callers a
  // value whose type contradicts this function's return type.
  const publicBaseUrl =
    typeof ingress.publicBaseUrl === "string" ? ingress.publicBaseUrl : "";
  const enabled =
    typeof ingress.enabled === "boolean" ? ingress.enabled : undefined;
  return {
    enabled: enabled === true,
    // `enabled` is opt-out across the assistant, so an unset flag is not off:
    // callers asking whether ingress is live read this, not `!enabled`.
    explicitlyDisabled: isPublicIngressDisabled({ ingress: { enabled } }),
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
