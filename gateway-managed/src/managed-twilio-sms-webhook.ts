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
import { normalizeManagedTwilioSmsPayload } from "./twilio-normalize.js";
import {
  buildManagedSignatureUrlCandidates,
  validateManagedTwilioSignature,
} from "./twilio-signature.js";

export const MANAGED_TWILIO_SMS_WEBHOOK_PATH = "/webhooks/twilio/sms";

type ManagedTwilioSmsPayload = {
  from: string;
  to: string;
  body: string;
  messageSid: string;
};

export async function handleManagedTwilioSmsWebhook(
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
  const paramsRecord = toRecord(params);

  const verification = validateManagedTwilioSignature(config, {
    url: buildManagedSignatureUrlCandidates(request),
    params: paramsRecord,
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

  const payload = parseSmsPayload(params);
  if (!payload) {
    return Response.json(
      {
        error: {
          code: "validation_error",
          detail: "Invalid managed Twilio SMS webhook payload.",
        },
      },
      { status: 400 },
    );
  }

  const normalizedEvent = normalizeManagedTwilioSmsPayload(paramsRecord);
  const routeResolution = await resolveManagedRoute(config, {
    routeType: "sms",
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
      code: "managed_sms_webhook_dispatched",
      provider: "twilio",
      route_type: "sms",
      message_sid: payload.messageSid,
      from: payload.from,
      to: payload.to,
      body: payload.body,
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

function parseSmsPayload(params: URLSearchParams): ManagedTwilioSmsPayload | null {
  const from = params.get("From")?.trim() || "";
  const to = params.get("To")?.trim() || "";
  const body = params.get("Body") || "";
  const messageSid = params.get("MessageSid")?.trim() || "";

  if (!from || !to || !messageSid) {
    return null;
  }

  return {
    from,
    to,
    body,
    messageSid,
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
