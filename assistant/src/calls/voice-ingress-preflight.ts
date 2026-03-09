import { loadConfig } from "../config/loader.js";
import type { AssistantConfig } from "../config/types.js";
import { shouldUsePlatformCallbacks } from "../inbound/platform-callback-registration.js";
import { getPublicBaseUrl } from "../inbound/public-ingress-urls.js";

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

function buildGatewayUnhealthyMessage(
  target: string,
  error: string | undefined,
  afterRecoveryAttempt: boolean,
): string {
  const detail = error ?? "Unknown gateway health check failure";
  if (afterRecoveryAttempt) {
    return `Voice callback gateway is still unhealthy at ${target} after a local recovery attempt: ${detail}`;
  }
  return `Voice callback gateway is unhealthy at ${target}: ${detail}`;
}

export async function preflightVoiceIngress(): Promise<VoiceIngressPreflightResult> {
  const ingressConfig = loadConfig();

  // Platform-callback deployments register routes with the platform and receive
  // stable callback URLs. No public ingress URL or local gateway is involved.
  if (shouldUsePlatformCallbacks()) {
    return {
      ok: true,
      ingressConfig,
      publicBaseUrl: "",
    };
  }

  let publicBaseUrl: string;
  try {
    publicBaseUrl = getPublicBaseUrl(ingressConfig);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(
      msg ||
        "Outbound voice calls require public ingress to be enabled and a public base URL (ingress.publicBaseUrl or INGRESS_PUBLIC_BASE_URL).",
    );
  }

  const { ensureLocalGatewayReady, probeLocalGatewayHealth } =
    await import("../runtime/local-gateway-health.js");

  const initialHealth = await probeLocalGatewayHealth();
  if (!initialHealth.healthy && !initialHealth.localDeployment) {
    return fail(
      buildGatewayUnhealthyMessage(
        initialHealth.target,
        initialHealth.error,
        false,
      ),
    );
  }

  if (initialHealth.localDeployment) {
    const recovery = await ensureLocalGatewayReady();
    // Re-probe after the wake flow so the dial path only continues when the
    // current gateway process is demonstrably serving the callback stack.
    const confirmedHealth = await probeLocalGatewayHealth();
    if (!confirmedHealth.healthy) {
      return fail(
        buildGatewayUnhealthyMessage(
          confirmedHealth.target,
          confirmedHealth.error ?? recovery.error,
          recovery.recoveryAttempted,
        ),
      );
    }
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
