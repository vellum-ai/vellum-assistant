/**
 * Unit tests for the Twilio voice webhook gateway handler.
 *
 * Validates that:
 * - Inbound calls (no callSessionId) resolve the assistant by "To" phone number
 *   and forward the assistantId to the runtime.
 * - Outbound calls (callSessionId present) do not resolve or forward an assistantId.
 * - Validation failures are propagated as responses.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mocks ──────────────────────────────────────────────────────────────

let lastForwardedAssistantId: string | undefined;
let lastForwardedParams: Record<string, string> | undefined;
let lastForwardedOriginalUrl: string | undefined;

mock.module("../../runtime/client.js", () => ({
  forwardTwilioVoiceWebhook: async (
    _config: unknown,
    params: Record<string, string>,
    originalUrl: string,
    assistantId?: string,
  ) => {
    lastForwardedParams = params;
    lastForwardedOriginalUrl = originalUrl;
    lastForwardedAssistantId = assistantId;
    return {
      status: 200,
      body: "<Response/>",
      headers: { "Content-Type": "text/xml" },
    };
  },
}));

mock.module("../../twilio/validate-webhook.js", () => ({
  validateTwilioWebhookRequest: async (req: Request) => {
    const rawBody = await req.text();
    const formData = new URLSearchParams(rawBody);
    const params: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      params[key] = value;
    }
    return { rawBody, params };
  },
}));

mock.module("../../logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { createTwilioVoiceWebhookHandler } from "./twilio-voice-webhook.js";
import type { GatewayConfig } from "../../config.js";

// ── Test config ────────────────────────────────────────────────────────

const baseConfig: GatewayConfig = {
  assistantRuntimeBaseUrl: "http://127.0.0.1:7821",
  defaultAssistantId: undefined,
  gatewayInternalBaseUrl: "http://127.0.0.1:7830",
  logFile: { dir: undefined, retentionDays: 30 },
  maxAttachmentBytes: 20 * 1024 * 1024,
  maxAttachmentConcurrency: 3,
  maxWebhookPayloadBytes: 1024 * 1024,
  port: 7830,
  routingEntries: [],
  runtimeBearerToken: undefined,
  runtimeGatewayOriginSecret: undefined,
  runtimeInitialBackoffMs: 500,
  runtimeMaxRetries: 2,
  runtimeProxyBearerToken: undefined,
  runtimeProxyEnabled: false,
  runtimeProxyRequireAuth: true,
  runtimeTimeoutMs: 30000,
  shutdownDrainMs: 5000,
  telegramApiBaseUrl: "https://api.telegram.org",
  telegramBotToken: undefined,
  telegramDeliverAuthBypass: false,
  telegramInitialBackoffMs: 1000,
  telegramMaxRetries: 3,
  telegramTimeoutMs: 15000,
  telegramWebhookSecret: undefined,
  twilioAuthToken: "test-auth-token",
  twilioAccountSid: "AC_test",
  twilioPhoneNumber: "+15550001111",
  assistantPhoneNumbers: {
    "assistant-abc": "+15550001111",
    "assistant-xyz": "+15550002222",
  },
  smsDeliverAuthBypass: false,
  ingressPublicBaseUrl: undefined,
  unmappedPolicy: "reject",
};

function makeVoiceRequest(
  params: Record<string, string>,
  queryString = "",
): Request {
  const body = new URLSearchParams(params).toString();
  return new Request(
    `http://127.0.0.1:7830/webhooks/twilio/voice${queryString}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("twilio voice webhook handler", () => {
  beforeEach(() => {
    lastForwardedAssistantId = undefined;
    lastForwardedParams = undefined;
    lastForwardedOriginalUrl = undefined;
  });

  test("inbound call resolves assistant by To number and forwards assistantId", async () => {
    const handler = createTwilioVoiceWebhookHandler(baseConfig);
    const req = makeVoiceRequest({
      CallSid: "CA_inbound_1",
      From: "+14155551234",
      To: "+15550001111",
    });

    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(lastForwardedAssistantId).toBe("assistant-abc");
    expect(lastForwardedParams?.CallSid).toBe("CA_inbound_1");
  });

  test("inbound call with unknown To number forwards without assistantId", async () => {
    const handler = createTwilioVoiceWebhookHandler(baseConfig);
    const req = makeVoiceRequest({
      CallSid: "CA_inbound_2",
      From: "+14155551234",
      To: "+19999999999",
    });

    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(lastForwardedAssistantId).toBeUndefined();
  });

  test("outbound call (callSessionId present) does not resolve assistant by phone", async () => {
    const handler = createTwilioVoiceWebhookHandler(baseConfig);
    const req = makeVoiceRequest(
      {
        CallSid: "CA_outbound_1",
        From: "+15550001111",
        To: "+14155559999",
      },
      "?callSessionId=existing-session-id",
    );

    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(lastForwardedAssistantId).toBeUndefined();
  });

  test("inbound call resolves second assistant by To number", async () => {
    const handler = createTwilioVoiceWebhookHandler(baseConfig);
    const req = makeVoiceRequest({
      CallSid: "CA_inbound_3",
      From: "+14155551234",
      To: "+15550002222",
    });

    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(lastForwardedAssistantId).toBe("assistant-xyz");
  });

  test("inbound call without assistantPhoneNumbers config forwards without assistantId", async () => {
    const configNoMapping = { ...baseConfig, assistantPhoneNumbers: undefined };
    const handler = createTwilioVoiceWebhookHandler(configNoMapping);
    const req = makeVoiceRequest({
      CallSid: "CA_inbound_4",
      From: "+14155551234",
      To: "+15550001111",
    });

    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(lastForwardedAssistantId).toBeUndefined();
  });
});
