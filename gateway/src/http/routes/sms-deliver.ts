import type { GatewayConfig } from "../../config.js";
import { validateBearerToken } from "../auth/bearer.js";
import { getLogger } from "../../logger.js";

const log = getLogger("sms-deliver");

/**
 * Send an SMS message via the Twilio Messages API.
 */
async function sendTwilioSms(
  accountSid: string,
  authToken: string,
  from: string,
  to: string,
  body: string,
): Promise<void> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const params = new URLSearchParams({ From: from, To: to, Body: body });
  const authHeader =
    "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Twilio Messages API error ${response.status}: ${text}`);
  }
}

function resolveFromNumber(
  config: GatewayConfig,
  assistantId?: string,
): string | undefined {
  if (assistantId) {
    const mapped = config.assistantPhoneNumbers?.[assistantId];
    if (mapped) return mapped;
  }
  return config.twilioPhoneNumber;
}

export function createSmsDeliverHandler(config: GatewayConfig) {
  return async (req: Request): Promise<Response> => {
    const traceId = req.headers.get("x-trace-id") ?? undefined;
    const tlog = traceId ? log.child({ traceId }) : log;

    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Fail-closed auth: when no bearer token is configured and the explicit
    // dev-only bypass flag is not set, refuse to serve requests (503) rather
    // than silently allowing unauthenticated access.
    if (!config.runtimeProxyBearerToken) {
      if (config.smsDeliverAuthBypass) {
        // Dev-only bypass — skip auth entirely.
      } else {
        return Response.json(
          { error: "Service not configured: bearer token required" },
          { status: 503 },
        );
      }
    } else {
      const authResult = validateBearerToken(
        req.headers.get("authorization"),
        config.runtimeProxyBearerToken,
      );
      if (!authResult.authorized) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    // Verify Twilio SMS sending is configured
    if (!config.twilioAccountSid || !config.twilioAuthToken) {
      tlog.error("Twilio SMS credentials not configured");
      return Response.json(
        { error: "SMS integration not configured" },
        { status: 503 },
      );
    }

    let body: {
      to?: string;
      chatId?: string;
      text?: string;
      assistantId?: string;
      attachments?: unknown[];
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const { text } = body;
    const assistantId = typeof body.assistantId === "string" ? body.assistantId : undefined;
    // Accept `chatId` as an alias for `to` so runtime channel callbacks
    // (which send `{ chatId, text }`) work without translation.
    const to = body.to ?? body.chatId;

    if (!to || typeof to !== "string") {
      return Response.json({ error: "to is required" }, { status: 400 });
    }

    // When text is missing but attachments are present, the assistant produced
    // a media-only reply that SMS cannot deliver. Use a graceful fallback
    // instead of rejecting outright so the user gets visible feedback.
    const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
    const effectiveText =
      (!text || (typeof text === "string" && text.trim().length === 0)) && hasAttachments
        ? "I have a media attachment to share, but SMS currently supports text only."
        : text;

    if (!effectiveText || typeof effectiveText !== "string") {
      return Response.json({ error: "text is required" }, { status: 400 });
    }

    const from = resolveFromNumber(config, assistantId);
    if (!from) {
      tlog.error({ assistantId }, "Twilio SMS phone number not configured");
      return Response.json(
        { error: "SMS integration not configured" },
        { status: 503 },
      );
    }

    try {
      await sendTwilioSms(
        config.twilioAccountSid,
        config.twilioAuthToken,
        from,
        to,
        effectiveText,
      );
    } catch (err) {
      tlog.error({ err, to }, "Failed to send SMS via Twilio");
      return Response.json({ error: "SMS delivery failed" }, { status: 502 });
    }

    tlog.info({ to, textLength: effectiveText.length }, "SMS delivered");
    return Response.json({ ok: true });
  };
}
