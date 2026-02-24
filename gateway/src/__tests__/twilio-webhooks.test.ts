import { describe, test, expect, mock, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import type { GatewayConfig } from "../config.js";

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(async () => new Response());

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

const { createTwilioVoiceWebhookHandler } = await import("../http/routes/twilio-voice-webhook.js");
const { createTwilioStatusWebhookHandler } = await import("../http/routes/twilio-status-webhook.js");
const { createTwilioConnectActionWebhookHandler } = await import("../http/routes/twilio-connect-action-webhook.js");

const AUTH_TOKEN = "test-twilio-auth-token";

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    telegramBotToken: "tok",
    telegramWebhookSecret: "wh-ver",
    telegramApiBaseUrl: "https://api.telegram.org",
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeBearerToken: "rt-token",
    runtimeGatewayOriginSecret: undefined,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: true,
    runtimeProxyBearerToken: undefined,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    telegramDeliverAuthBypass: false,
    telegramInitialBackoffMs: 1000,
    telegramMaxRetries: 3,
    telegramTimeoutMs: 15000,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: 20971520,
    maxAttachmentConcurrency: 3,
    twilioAuthToken: AUTH_TOKEN,
    twilioAccountSid: undefined,
    twilioPhoneNumber: undefined,
    smsDeliverAuthBypass: false,
    ingressPublicBaseUrl: undefined,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    whatsappPhoneNumberId: undefined,
    whatsappAccessToken: undefined,
    whatsappAppSecret: undefined,
    whatsappWebhookVerifyToken: undefined,
    whatsappDeliverAuthBypass: false,
    whatsappTimeoutMs: 15000,
    whatsappMaxRetries: 3,
    whatsappInitialBackoffMs: 1000,
    ...overrides,
  };
  if (merged.runtimeGatewayOriginSecret === undefined) {
    merged.runtimeGatewayOriginSecret = merged.runtimeBearerToken;
  }
  return merged;
}

/**
 * Compute a valid Twilio signature for the given URL + params.
 */
function computeSignature(
  url: string,
  params: Record<string, string>,
  authToken: string,
): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  return createHmac("sha1", authToken).update(data).digest("base64");
}

/**
 * Build a signed Twilio webhook request.
 */
function buildSignedRequest(
  url: string,
  params: Record<string, string>,
  authToken: string,
  extraHeaders: Record<string, string> = {},
): Request {
  const body = new URLSearchParams(params).toString();
  const signature = computeSignature(url, params, authToken);
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": signature,
      ...extraHeaders,
    },
    body,
  });
}

describe("Twilio voice webhook", () => {
  afterEach(() => {
    fetchMock = mock(async () => new Response());
  });

  test("rejects GET requests with 405", async () => {
    const handler = createTwilioVoiceWebhookHandler(makeConfig());
    const req = new Request("http://localhost:7830/webhooks/twilio/voice", {
      method: "GET",
    });
    const res = await handler(req);
    expect(res.status).toBe(405);
  });

  test("rejects missing signature with 403", async () => {
    const handler = createTwilioVoiceWebhookHandler(makeConfig());
    const req = new Request("http://localhost:7830/webhooks/twilio/voice", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "CallSid=CA123&CallStatus=ringing",
    });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  test("rejects invalid signature with 403", async () => {
    const handler = createTwilioVoiceWebhookHandler(makeConfig());
    const req = new Request("http://localhost:7830/webhooks/twilio/voice", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": "invalid-signature",
      },
      body: "CallSid=CA123&CallStatus=ringing",
    });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  test("rejects when twilioAuthToken is not configured (fail-closed)", async () => {
    const handler = createTwilioVoiceWebhookHandler(
      makeConfig({ twilioAuthToken: undefined }),
    );
    const req = new Request("http://localhost:7830/webhooks/twilio/voice", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "CallSid=CA123",
    });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  test("forwards valid signed request to runtime and returns response", async () => {
    const twiml = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
    fetchMock = mock(async () =>
      new Response(twiml, {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      }),
    );

    const handler = createTwilioVoiceWebhookHandler(makeConfig());
    const url = "http://localhost:7830/webhooks/twilio/voice?callSessionId=sess-1";
    const params = { CallSid: "CA123", AccountSid: "AC456" };
    const req = buildSignedRequest(url, params, AUTH_TOKEN);

    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toBe(twiml);

    // Verify the fetch was called to the runtime's internal endpoint
    const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(calledUrl).toContain("/v1/internal/twilio/voice-webhook");
  });

  test("returns 502 when runtime is unreachable", async () => {
    fetchMock = mock(async () => { throw new Error("Connection refused"); });

    const handler = createTwilioVoiceWebhookHandler(makeConfig());
    const url = "http://localhost:7830/webhooks/twilio/voice";
    const params = { CallSid: "CA123" };
    const req = buildSignedRequest(url, params, AUTH_TOKEN);

    const res = await handler(req);
    expect(res.status).toBe(502);
  });

  test("rejects oversized payload via Content-Length header", async () => {
    const handler = createTwilioVoiceWebhookHandler(
      makeConfig({ maxWebhookPayloadBytes: 100 }),
    );
    const req = new Request("http://localhost:7830/webhooks/twilio/voice", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": "999999",
        "X-Twilio-Signature": "irrelevant",
      },
      body: "x".repeat(200),
    });
    const res = await handler(req);
    expect(res.status).toBe(413);
  });

  test("rejects oversized payload via actual body size", async () => {
    const handler = createTwilioVoiceWebhookHandler(
      makeConfig({ maxWebhookPayloadBytes: 50 }),
    );
    const largeBody = "CallSid=" + "A".repeat(100);
    const url = "http://localhost:7830/webhooks/twilio/voice";
    const signature = computeSignature(
      url,
      Object.fromEntries(new URLSearchParams(largeBody).entries()),
      AUTH_TOKEN,
    );
    const req = new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": signature,
      },
      body: largeBody,
    });
    const res = await handler(req);
    expect(res.status).toBe(413);
  });
});

describe("Twilio status webhook", () => {
  afterEach(() => {
    fetchMock = mock(async () => new Response());
  });

  test("rejects invalid signature with 403", async () => {
    const handler = createTwilioStatusWebhookHandler(makeConfig());
    const req = new Request("http://localhost:7830/webhooks/twilio/status", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": "bad",
      },
      body: "CallSid=CA123&CallStatus=completed",
    });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  test("forwards valid signed request to runtime", async () => {
    fetchMock = mock(async () => new Response(null, { status: 200 }));

    const handler = createTwilioStatusWebhookHandler(makeConfig());
    const url = "http://localhost:7830/webhooks/twilio/status";
    const params = { CallSid: "CA123", CallStatus: "completed" };
    const req = buildSignedRequest(url, params, AUTH_TOKEN);

    const res = await handler(req);
    expect(res.status).toBe(200);

    const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(calledUrl).toContain("/v1/internal/twilio/status");
  });

  test("returns 502 when runtime returns error", async () => {
    fetchMock = mock(async () => { throw new Error("Runtime down"); });

    const handler = createTwilioStatusWebhookHandler(makeConfig());
    const url = "http://localhost:7830/webhooks/twilio/status";
    const params = { CallSid: "CA123", CallStatus: "completed" };
    const req = buildSignedRequest(url, params, AUTH_TOKEN);

    const res = await handler(req);
    expect(res.status).toBe(502);
  });
});

describe("Twilio connect-action webhook", () => {
  afterEach(() => {
    fetchMock = mock(async () => new Response());
  });

  test("rejects invalid signature with 403", async () => {
    const handler = createTwilioConnectActionWebhookHandler(makeConfig());
    const req = new Request("http://localhost:7830/webhooks/twilio/connect-action", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": "wrong",
      },
      body: "CallSid=CA123",
    });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  test("forwards valid signed request to runtime", async () => {
    const twiml = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
    fetchMock = mock(async () =>
      new Response(twiml, {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      }),
    );

    const handler = createTwilioConnectActionWebhookHandler(makeConfig());
    const url = "http://localhost:7830/webhooks/twilio/connect-action";
    const params = { CallSid: "CA123" };
    const req = buildSignedRequest(url, params, AUTH_TOKEN);

    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toBe(twiml);

    const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(calledUrl).toContain("/v1/internal/twilio/connect-action");
  });
});

describe("Twilio webhook signature with canonical ingress base URL", () => {
  afterEach(() => {
    fetchMock = mock(async () => new Response());
  });

  test("validates signature against ingressPublicBaseUrl when configured", async () => {
    const twiml = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
    fetchMock = mock(async () =>
      new Response(twiml, {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      }),
    );

    const publicBaseUrl = "https://public.example.com";
    const config = makeConfig({ ingressPublicBaseUrl: publicBaseUrl });
    const handler = createTwilioVoiceWebhookHandler(config);

    // The local URL is different from the public URL
    const localUrl = "http://localhost:7830/webhooks/twilio/voice";
    const publicUrl = publicBaseUrl + "/webhooks/twilio/voice";
    const params = { CallSid: "CA123" };

    // Sign against the PUBLIC URL (as Twilio would)
    const signature = computeSignature(publicUrl, params, AUTH_TOKEN);
    const body = new URLSearchParams(params).toString();
    const req = new Request(localUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": signature,
      },
      body,
    });

    const res = await handler(req);
    expect(res.status).toBe(200);
  });

  test("accepts when signature matches raw request URL even with public URL configured", async () => {
    fetchMock = mock(async () =>
      new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      }),
    );

    const publicBaseUrl = "https://public.example.com";
    const config = makeConfig({ ingressPublicBaseUrl: publicBaseUrl });
    const handler = createTwilioVoiceWebhookHandler(config);

    const localUrl = "http://localhost:7830/webhooks/twilio/voice";
    const params = { CallSid: "CA123" };

    // Sign against the raw request URL — the raw URL is always included as
    // a final fallback candidate to prevent false 403s in mixed setups.
    const signature = computeSignature(localUrl, params, AUTH_TOKEN);
    const body = new URLSearchParams(params).toString();
    const req = new Request(localUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": signature,
      },
      body,
    });

    const res = await handler(req);
    expect(res.status).toBe(200);
  });

  test("accepts signature from forwarded public URL headers when configured URL is stale", async () => {
    fetchMock = mock(async () =>
      new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      }),
    );

    const staleConfiguredBase = "https://stale.example.com";
    const config = makeConfig({ ingressPublicBaseUrl: staleConfiguredBase });
    const handler = createTwilioVoiceWebhookHandler(config);

    const localUrl = "http://localhost:7830/webhooks/twilio/voice";
    const forwardedBase = "https://fresh-tunnel.example.com";
    const signedPublicUrl = `${forwardedBase}/webhooks/twilio/voice`;
    const params = { CallSid: "CA123" };
    const req = buildSignedRequest(
      signedPublicUrl,
      params,
      AUTH_TOKEN,
      {
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "fresh-tunnel.example.com",
      },
    );

    // Gateway receives the local URL from the tunnel, but should still
    // validate against the forwarded public URL headers.
    const tunneledReq = new Request(localUrl, {
      method: req.method,
      headers: req.headers,
      body: await req.text(),
    });

    const res = await handler(tunneledReq);
    expect(res.status).toBe(200);
  });
});
