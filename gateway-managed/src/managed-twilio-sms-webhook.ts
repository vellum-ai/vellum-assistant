import type { ManagedGatewayConfig } from "./config.js";
import { normalizeManagedTwilioSmsPayload } from "./twilio-normalize.js";
import { validateManagedTwilioSignature } from "./twilio-signature.js";

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

  // Build normalized shared event shape now so follow-up PRs can attach
  // route resolution and dispatch without changing this endpoint contract.
  const _normalizedEvent = normalizeManagedTwilioSmsPayload(toRecord(params));
  void _normalizedEvent;

  return Response.json(
    {
      status: "accepted",
      code: "managed_sms_webhook_stub",
      provider: "twilio",
      route_type: "sms",
      message_sid: payload.messageSid,
      from: payload.from,
      to: payload.to,
      body: payload.body,
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
