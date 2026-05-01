import { getIsPlatform } from "../config/env-registry.js";
import { loadConfig } from "../config/loader.js";
import type { AssistantConfig } from "../config/types.js";
import { getTwilioPublicBaseUrl } from "../inbound/public-ingress-urls.js";

const SERVICE_UNAVAILABLE_STATUS = 503 as const;

export interface VoiceIngressPreflightSuccess {
  ok: true;
  ingressConfig: AssistantConfig;
  publicBaseUrl: string;
}

export interface VoiceIngressPreflightFailure {
  ok: false;
  error: string;
  status: typeof SERVICE_UNAVAILABLE_STATUS;
}

export type VoiceIngressPreflightResult =
  | VoiceIngressPreflightSuccess
  | VoiceIngressPreflightFailure;

function fail(error: string): VoiceIngressPreflightFailure {
  return {
    ok: false,
    error,
    status: SERVICE_UNAVAILABLE_STATUS,
  };
}

export async function preflightVoiceIngress(): Promise<VoiceIngressPreflightResult> {
  const ingressConfig = loadConfig();

  // Platform-callback deployments register routes with the platform and receive
  // stable callback URLs. No public ingress URL or local gateway is involved.
  if (getIsPlatform()) {
    return {
      ok: true,
      ingressConfig,
      publicBaseUrl: "",
    };
  }

  let publicBaseUrl: string;
  try {
    publicBaseUrl = getTwilioPublicBaseUrl(ingressConfig);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(
      msg ||
        "Outbound voice calls require public ingress to be enabled and a Twilio public base URL (ingress.twilioPublicBaseUrl or ingress.publicBaseUrl).",
    );
  }

  return {
    ok: true,
    ingressConfig: {
      ...ingressConfig,
      ingress: {
        ...(ingressConfig.ingress ?? {}),
        enabled: true,
        publicBaseUrl,
      },
    },
    publicBaseUrl,
  };
}
