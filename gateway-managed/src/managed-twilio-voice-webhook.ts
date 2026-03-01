import type { ManagedGatewayConfig } from "./config.js";
import {
  dispatchManagedInboundEvent,
  type ManagedInboundDispatchResult,
} from "./managed-inbound-dispatch-client.js";
import {
  resolveManagedRoute,
  type ManagedRouteResolutionResult,
} from "./managed-route-resolution-client.js";
import type { ManagedGatewayUpstreamFetch } from "./route-resolve.js";
import { normalizeManagedTwilioVoicePayload } from "./twilio-normalize.js";
import { validateManagedTwilioSignature } from "./twilio-signature.js";

export const MANAGED_TWILIO_VOICE_WEBHOOK_PATH = "/webhooks/twilio/voice";

type ManagedTwilioVoicePayload = {
  from: string;
  to: string;
  callSid: string;
  callStatus: string;
};

export async function handleManagedTwilioVoiceWebhook(
  request: Request,
  config: ManagedGatewayConfig,
  fetchImpl?: ManagedGatewayUpstreamFetch,
): Promise<Response> {
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

  let rawBody = "";
  try {
    rawBody = await request.text();
  } catch {
    return Response.json(
      {
        error: {
          code: "invalid_request_body",
          detail: "Failed to read request body.",
        },
      },
      { status: 400 },
    );
  }

  const params = new URLSearchParams(rawBody);
  const payload = parseVoicePayload(params);
  if (!payload) {
    return Response.json(
      {
        error: {
          code: "validation_error",
          detail: "Invalid managed Twilio voice webhook payload.",
        },
      },
      { status: 400 },
    );
  }

  const verification = validateManagedTwilioSignature(config, {
    url: request.url,
    params: toRecord(params),
    signature: request.headers.get("x-twilio-signature"),
  });
  if (!verification.ok) {
    return Response.json(
      {
        error: {
          code: verification.code,
          detail: verification.detail,
        },
      },
      { status: 403 },
    );
  }

  const normalizedEvent = normalizeManagedTwilioVoicePayload(toRecord(params));
  const routeResolution = await resolveManagedRoute(config, {
    routeType: "voice",
    identityKey: payload.to,
    fetchImpl,
  });
  if (!routeResolution.ok) {
    return routeResolutionErrorResponse(routeResolution);
  }
  const dispatchResult = await dispatchManagedInboundEvent(config, {
    route: routeResolution.route,
    normalizedEvent,
    fetchImpl,
  });
  if (!dispatchResult.ok) {
    return dispatchErrorResponse(dispatchResult);
  }

  return Response.json(
    {
      status: "accepted",
      code: "managed_voice_webhook_dispatched",
      provider: "twilio",
      route_type: "voice",
      call_sid: payload.callSid,
      call_status: payload.callStatus,
      from: payload.from,
      to: payload.to,
      assistant_id: routeResolution.route.assistantId,
      route_id: routeResolution.route.routeId,
      normalized_event: normalizedEvent,
      dispatch: {
        status: dispatchResult.dispatch.status,
        ...(dispatchResult.dispatch.eventId ? { event_id: dispatchResult.dispatch.eventId } : {}),
        ...(typeof dispatchResult.dispatch.duplicate === "boolean"
          ? { duplicate: dispatchResult.dispatch.duplicate }
          : {}),
      },
    },
    { status: 202 },
  );
}

function parseVoicePayload(params: URLSearchParams): ManagedTwilioVoicePayload | null {
  const from = params.get("From")?.trim() || "";
  const to = params.get("To")?.trim() || "";
  const callSid = params.get("CallSid")?.trim() || "";
  const callStatus = params.get("CallStatus")?.trim() || "";

  if (!from || !to || !callSid || !callStatus) {
    return null;
  }

  return {
    from,
    to,
    callSid,
    callStatus,
  };
}

function toRecord(params: URLSearchParams): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    record[key] = value;
  }
  return record;
}

function routeResolutionErrorResponse(
  result: Extract<ManagedRouteResolutionResult, { ok: false }>,
): Response {
  return Response.json(
    {
      error: {
        code: result.error.code,
        detail: result.error.detail,
      },
    },
    { status: result.status },
  );
}

function dispatchErrorResponse(
  result: Extract<ManagedInboundDispatchResult, { ok: false }>,
): Response {
  return Response.json(
    {
      error: {
        code: result.error.code,
        detail: result.error.detail,
      },
    },
    { status: result.status },
  );
}
