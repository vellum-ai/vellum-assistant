import type { ManagedGatewayConfig } from "./config.js";
import {
  handleManagedTwilioSmsWebhook,
  MANAGED_TWILIO_SMS_WEBHOOK_PATH,
} from "./managed-twilio-sms-webhook.js";
import {
  handleManagedTwilioVoiceWebhook,
  MANAGED_TWILIO_VOICE_WEBHOOK_PATH,
} from "./managed-twilio-voice-webhook.js";
import {
  createRouteResolveHandler,
  MANAGED_GATEWAY_ROUTE_RESOLVE_PATH,
  type ManagedGatewayUpstreamFetch,
} from "./route-resolve.js";

export type ManagedGatewayAppDependencies = {
  fetchImpl?: ManagedGatewayUpstreamFetch;
};

export function healthPayload(config: ManagedGatewayConfig) {
  return {
    status: "ok",
    service: config.serviceName,
    mode: config.mode,
    enabled: config.enabled,
  };
}

export function readinessResponse(config: ManagedGatewayConfig): Response {
  if (!config.enabled) {
    return Response.json(
      {
        status: "not_ready",
        service: config.serviceName,
        mode: config.mode,
        reason: "managed_gateway_disabled",
      },
      { status: 503 },
    );
  }

  const payload: Record<string, string> = {
    status: "ready",
    service: config.serviceName,
    mode: config.mode,
  };
  if (config.djangoInternalBaseUrl) {
    payload.upstreamBaseUrl = config.djangoInternalBaseUrl;
  }

  return Response.json(payload);
}

export function createManagedGatewayAppFetch(
  config: ManagedGatewayConfig,
  dependencies: ManagedGatewayAppDependencies = {},
): (request: Request) => Promise<Response> {
  const routeResolveHandler = createRouteResolveHandler(
    config,
    dependencies.fetchImpl,
  );

  return async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url).pathname;

    if (
      pathname === "/healthz"
      || pathname === "/v1/internal/managed-gateway/healthz/"
    ) {
      return Response.json(healthPayload(config));
    }

    if (
      pathname === "/readyz"
      || pathname === "/v1/internal/managed-gateway/readyz/"
    ) {
      return readinessResponse(config);
    }

    if (pathname === MANAGED_GATEWAY_ROUTE_RESOLVE_PATH) {
      if (request.method !== "POST") {
        return Response.json(
          {
            error: {
              code: "method_not_allowed",
              detail: "Only POST is supported for this endpoint.",
            },
          },
          {
            status: 405,
            headers: { allow: "POST" },
          },
        );
      }

      return routeResolveHandler(request);
    }

    if (pathname === MANAGED_TWILIO_SMS_WEBHOOK_PATH) {
      return handleManagedTwilioSmsWebhook(request, config, dependencies.fetchImpl);
    }

    if (pathname === MANAGED_TWILIO_VOICE_WEBHOOK_PATH) {
      return handleManagedTwilioVoiceWebhook(request, config, dependencies.fetchImpl);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  };
}
