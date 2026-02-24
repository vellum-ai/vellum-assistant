import { describe, test, expect, mock, afterEach } from "bun:test";
import type { GatewayConfig } from "../config.js";

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(async () => new Response());

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

const { createOAuthCallbackHandler } = await import("../http/routes/oauth-callback.js");

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
    twilioAuthToken: undefined,
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

describe("OAuth callback handler", () => {
  afterEach(() => {
    fetchMock = mock(async () => new Response());
  });

  test("forwards valid state+code to runtime and returns success page", async () => {
    fetchMock = mock(async () =>
      Response.json({ ok: true }, { status: 200 }),
    );

    const handler = createOAuthCallbackHandler(makeConfig());
    const req = new Request(
      "http://localhost:7830/webhooks/oauth/callback?state=abc123&code=authcode456",
      { method: "GET" },
    );

    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toContain("Authorization Successful");
    expect(body).toContain("close this tab");

    // Verify fetch was called with the runtime internal endpoint
    const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(calledUrl).toBe("http://localhost:7821/v1/internal/oauth/callback");

    const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    const sentBody = JSON.parse(calledInit.body as string);
    expect(sentBody.state).toBe("abc123");
    expect(sentBody.code).toBe("authcode456");
    expect(sentBody.error).toBeUndefined();

    const headers = calledInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer rt-token");
  });

  test("missing state parameter returns 400 error page", async () => {
    const handler = createOAuthCallbackHandler(makeConfig());
    const req = new Request(
      "http://localhost:7830/webhooks/oauth/callback?code=authcode456",
      { method: "GET" },
    );

    const res = await handler(req);
    expect(res.status).toBe(400);

    const body = await res.text();
    expect(body).toContain("Authorization Failed");
    expect(body).toContain("Missing state parameter");
  });

  test("error param is forwarded to runtime", async () => {
    fetchMock = mock(async () =>
      Response.json({ ok: true }, { status: 200 }),
    );

    const handler = createOAuthCallbackHandler(makeConfig());
    const req = new Request(
      "http://localhost:7830/webhooks/oauth/callback?state=abc123&error=access_denied",
      { method: "GET" },
    );

    const res = await handler(req);
    expect(res.status).toBe(200);

    const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    const sentBody = JSON.parse(calledInit.body as string);
    expect(sentBody.state).toBe("abc123");
    expect(sentBody.error).toBe("access_denied");
    expect(sentBody.code).toBeUndefined();
  });

  test("runtime returning 404 (unknown state) shows error page", async () => {
    fetchMock = mock(async () =>
      Response.json({ error: "Unknown state" }, { status: 404 }),
    );

    const handler = createOAuthCallbackHandler(makeConfig());
    const req = new Request(
      "http://localhost:7830/webhooks/oauth/callback?state=expired123&code=code",
      { method: "GET" },
    );

    const res = await handler(req);
    expect(res.status).toBe(400);

    const body = await res.text();
    expect(body).toContain("Authorization Failed");
  });

  test("runtime unreachable returns 502 error page", async () => {
    fetchMock = mock(async () => { throw new Error("Connection refused"); });

    const handler = createOAuthCallbackHandler(makeConfig());
    const req = new Request(
      "http://localhost:7830/webhooks/oauth/callback?state=abc123&code=code",
      { method: "GET" },
    );

    const res = await handler(req);
    expect(res.status).toBe(502);

    const body = await res.text();
    expect(body).toContain("Authorization Failed");
  });

  test("omits Authorization header when runtimeBearerToken is undefined", async () => {
    fetchMock = mock(async () =>
      Response.json({ ok: true }, { status: 200 }),
    );

    const handler = createOAuthCallbackHandler(
      makeConfig({ runtimeBearerToken: undefined }),
    );
    const req = new Request(
      "http://localhost:7830/webhooks/oauth/callback?state=s1&code=c1",
      { method: "GET" },
    );

    await handler(req);

    const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    const headers = calledInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });
});
