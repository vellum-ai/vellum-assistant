import { describe, it, expect, mock, afterEach } from "bun:test";
import type { GatewayConfig } from "../../config.js";

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(async () => new Response());

mock.module("../../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

const { createSmsDeliverHandler } = await import("./sms-deliver.js");

// --- Helpers ---------------------------------------------------------------

const TOKEN = "test-deliver-token";

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    assistantRuntimeBaseUrl: "http://localhost:7821",
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
    runtimeProxyBearerToken: TOKEN,
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
    twilioAuthToken: "test-twilio-auth",
    twilioAccountSid: "AC-test-sid",
    twilioPhoneNumber: "+15551234567",
    smsDeliverAuthBypass: false,
    ingressPublicBaseUrl: undefined,
    assistantEmail: undefined,
    unmappedPolicy: "reject",
    ...overrides,
  };
  if (merged.runtimeGatewayOriginSecret === undefined) {
    merged.runtimeGatewayOriginSecret = merged.runtimeBearerToken;
  }
  return merged;
}

function makeRequest(body: unknown, headers?: Record<string, string>): Request {
  return new Request("http://localhost:7830/deliver/sms", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  fetchMock = mock(async () => new Response());
});

function mockTwilioApi(overrides?: Record<string, unknown>) {
  fetchMock = mock(async () => {
    return new Response(JSON.stringify({ sid: "SM-sent", status: "queued", error_code: null, error_message: null, ...overrides }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  });
}

// --- Tests -----------------------------------------------------------------

describe("/deliver/sms", () => {
  it("rejects GET requests with 405", async () => {
    const handler = createSmsDeliverHandler(makeConfig());
    const req = new Request("http://localhost:7830/deliver/sms", {
      method: "GET",
    });
    const res = await handler(req);
    expect(res.status).toBe(405);
  });

  it("rejects when no bearer token and bypass not set with 503", async () => {
    const handler = createSmsDeliverHandler(
      makeConfig({ runtimeProxyBearerToken: undefined }),
    );
    const req = makeRequest({ to: "+15559876543", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Service not configured: bearer token required");
  });

  it("rejects request without Authorization header with 401", async () => {
    const handler = createSmsDeliverHandler(makeConfig());
    const req = makeRequest({ to: "+15559876543", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(401);
  });

  it("rejects request with wrong bearer token with 401", async () => {
    const handler = createSmsDeliverHandler(makeConfig());
    const req = makeRequest({ to: "+15559876543", text: "hello" }, {
      authorization: "Bearer wrong-token",
    });
    const res = await handler(req);
    expect(res.status).toBe(401);
  });

  it("accepts request with correct bearer token", async () => {
    mockTwilioApi();
    const handler = createSmsDeliverHandler(makeConfig());
    const req = makeRequest({ to: "+15559876543", text: "hello" }, {
      authorization: `Bearer ${TOKEN}`,
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("allows unauthenticated access when bypass flag is set and no token configured", async () => {
    mockTwilioApi();
    const handler = createSmsDeliverHandler(
      makeConfig({ runtimeProxyBearerToken: undefined, smsDeliverAuthBypass: true }),
    );
    const req = makeRequest({ to: "+15559876543", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("returns 503 when Twilio credentials are not configured", async () => {
    const handler = createSmsDeliverHandler(
      makeConfig({
        runtimeProxyBearerToken: undefined,
        smsDeliverAuthBypass: true,
        twilioAccountSid: undefined,
      }),
    );
    const req = makeRequest({ to: "+15559876543", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("SMS integration not configured");
  });

  it("returns 400 when 'to' is missing", async () => {
    const handler = createSmsDeliverHandler(
      makeConfig({ runtimeProxyBearerToken: undefined, smsDeliverAuthBypass: true }),
    );
    const req = makeRequest({ text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("to is required");
  });

  it("returns 400 when 'text' is missing", async () => {
    const handler = createSmsDeliverHandler(
      makeConfig({ runtimeProxyBearerToken: undefined, smsDeliverAuthBypass: true }),
    );
    const req = makeRequest({ to: "+15559876543" });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("text is required");
  });

  it("returns 400 when JSON is invalid", async () => {
    const handler = createSmsDeliverHandler(
      makeConfig({ runtimeProxyBearerToken: undefined, smsDeliverAuthBypass: true }),
    );
    const req = new Request("http://localhost:7830/deliver/sms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON");
  });

  it("returns 502 when Twilio API fails", async () => {
    fetchMock = mock(async () => {
      return new Response(JSON.stringify({ message: "Bad Request" }), {
        status: 400,
      });
    });

    const handler = createSmsDeliverHandler(
      makeConfig({ runtimeProxyBearerToken: undefined, smsDeliverAuthBypass: true }),
    );
    const req = makeRequest({ to: "+15559876543", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("SMS delivery failed");
  });

  it("accepts { chatId, text } and sends Twilio request to chatId", async () => {
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    fetchMock = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      fetchCalls.push({ url: urlStr, init: init ?? {} });
      return new Response(JSON.stringify({ sid: "SM-sent" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createSmsDeliverHandler(
      makeConfig({ runtimeProxyBearerToken: undefined, smsDeliverAuthBypass: true }),
    );
    const req = makeRequest({ chatId: "+15559876543", text: "hello via chatId" }, {});
    const res = await handler(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify the Twilio Messages API was called with chatId as the To number
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("AC-test-sid/Messages.json");
    const sentBody = fetchCalls[0].init.body as string;
    const sentParams = new URLSearchParams(sentBody);
    expect(sentParams.get("To")).toBe("+15559876543");
    expect(sentParams.get("Body")).toBe("hello via chatId");
  });

  it("prefers 'to' over 'chatId' when both are provided", async () => {
    mockTwilioApi();
    const handler = createSmsDeliverHandler(
      makeConfig({ runtimeProxyBearerToken: undefined, smsDeliverAuthBypass: true }),
    );
    const req = makeRequest({ to: "+15551111111", chatId: "+15552222222", text: "both fields" }, {});
    const res = await handler(req);
    expect(res.status).toBe(200);
  });

  it("sends correct Twilio API request", async () => {
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    fetchMock = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      fetchCalls.push({ url: urlStr, init: init ?? {} });
      return new Response(JSON.stringify({ sid: "SM-sent" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createSmsDeliverHandler(
      makeConfig({ runtimeProxyBearerToken: undefined, smsDeliverAuthBypass: true }),
    );
    const req = makeRequest({ to: "+15559876543", text: "Test SMS body" });
    const res = await handler(req);
    expect(res.status).toBe(200);

    // Verify the Twilio Messages API was called correctly
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("AC-test-sid/Messages.json");
    const sentBody = fetchCalls[0].init.body as string;
    const sentParams = new URLSearchParams(sentBody);
    expect(sentParams.get("From")).toBe("+15551234567");
    expect(sentParams.get("To")).toBe("+15559876543");
    expect(sentParams.get("Body")).toBe("Test SMS body");
  });

  it("uses assistant-specific From number when assistantId mapping exists", async () => {
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    fetchMock = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      fetchCalls.push({ url: urlStr, init: init ?? {} });
      return new Response(JSON.stringify({ sid: "SM-sent" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createSmsDeliverHandler(
      makeConfig({
        runtimeProxyBearerToken: undefined,
        smsDeliverAuthBypass: true,
        assistantPhoneNumbers: { "ast-alpha": "+15550001111" },
      }),
    );
    const req = makeRequest({
      to: "+15559876543",
      text: "assistant scoped",
      assistantId: "ast-alpha",
    });

    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    const sentBody = fetchCalls[0].init.body as string;
    const sentParams = new URLSearchParams(sentBody);
    expect(sentParams.get("From")).toBe("+15550001111");
  });

  it("falls back to global From number when assistant mapping is missing", async () => {
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    fetchMock = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      fetchCalls.push({ url: urlStr, init: init ?? {} });
      return new Response(JSON.stringify({ sid: "SM-sent" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createSmsDeliverHandler(
      makeConfig({
        runtimeProxyBearerToken: undefined,
        smsDeliverAuthBypass: true,
        assistantPhoneNumbers: { "ast-beta": "+15550002222" },
      }),
    );
    const req = makeRequest({
      to: "+15559876543",
      text: "fallback",
      assistantId: "ast-alpha",
    });

    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    const sentBody = fetchCalls[0].init.body as string;
    const sentParams = new URLSearchParams(sentBody);
    expect(sentParams.get("From")).toBe("+15551234567");
  });

  it("attachment-only request (no text) uses fallback text", async () => {
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    fetchMock = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      fetchCalls.push({ url: urlStr, init: init ?? {} });
      return new Response(JSON.stringify({ sid: "SM-sent" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createSmsDeliverHandler(
      makeConfig({ runtimeProxyBearerToken: undefined, smsDeliverAuthBypass: true }),
    );
    const req = makeRequest({
      to: "+15559876543",
      attachments: [{ url: "https://example.com/image.png" }],
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify the Twilio Messages API was called
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("AC-test-sid/Messages.json");

    // Verify the Body parameter contains the fallback text
    const sentBody = fetchCalls[0].init.body as string;
    const sentParams = new URLSearchParams(sentBody);
    expect(sentParams.get("Body")).toBe(
      "I have a media attachment to share, but SMS currently supports text only.",
    );
  });

  it("returns enriched Twilio acceptance details in response", async () => {
    mockTwilioApi({ sid: "SM-enrich-test", status: "queued", error_code: null, error_message: null });
    const handler = createSmsDeliverHandler(
      makeConfig({ runtimeProxyBearerToken: undefined, smsDeliverAuthBypass: true }),
    );
    const req = makeRequest({ to: "+15559876543", text: "enriched" });
    const res = await handler(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.messageSid).toBe("SM-enrich-test");
    expect(body.status).toBe("queued");
    expect(body.errorCode).toBeNull();
    expect(body.errorMessage).toBeNull();
  });

  it("returns Twilio error details in response when error_code is present", async () => {
    mockTwilioApi({ sid: "SM-err-test", status: "failed", error_code: 30003, error_message: "Unreachable" });
    const handler = createSmsDeliverHandler(
      makeConfig({ runtimeProxyBearerToken: undefined, smsDeliverAuthBypass: true }),
    );
    const req = makeRequest({ to: "+15559876543", text: "fail test" });
    const res = await handler(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.messageSid).toBe("SM-err-test");
    expect(body.status).toBe("failed");
    expect(body.errorCode).toBe("30003");
    expect(body.errorMessage).toBe("Unreachable");
  });

  it("returns 503 when no From number is available", async () => {
    const handler = createSmsDeliverHandler(
      makeConfig({
        runtimeProxyBearerToken: undefined,
        smsDeliverAuthBypass: true,
        twilioPhoneNumber: undefined,
        assistantPhoneNumbers: undefined,
      }),
    );
    const req = makeRequest({
      to: "+15559876543",
      text: "no from",
      assistantId: "ast-alpha",
    });

    const res = await handler(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("SMS integration not configured");
  });
});
