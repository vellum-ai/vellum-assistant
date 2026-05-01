import { describe, test, expect, mock, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import type { GatewayConfig } from "../config.js";
import type { CredentialCache } from "../credential-cache.js";
import type { ConfigFileCache } from "../config-file-cache.js";
import { credentialKey } from "../credential-key.js";
import { initSigningKey } from "../auth/token-service.js";

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);
const logCalls: { args: unknown[]; method: string }[] = [];

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

function createMockLogger(): Record<string, unknown> {
  const target = {} as Record<string, unknown>;
  const proxy = new Proxy(target, {
    get: (_innerTarget, prop) => {
      if (prop === "child") {
        return () => proxy;
      }

      if (typeof prop !== "string") return undefined;

      return (...args: unknown[]) => {
        logCalls.push({ method: prop, args });
      };
    },
  });

  return proxy;
}

mock.module("../logger.js", () => ({
  getLogger: () => createMockLogger(),
}));

const { createTwilioVoiceWebhookHandler } =
  await import("../http/routes/twilio-voice-webhook.js");
const { createTwilioStatusWebhookHandler } =
  await import("../http/routes/twilio-status-webhook.js");
const { createTwilioConnectActionWebhookHandler } =
  await import("../http/routes/twilio-connect-action-webhook.js");

const AUTH_TOKEN = "test-twilio-auth-token";

afterEach(() => {
  fetchMock = mock(async () => new Response());
  logCalls.length = 0;
});

function findLogCall(message: string): {
  args: unknown[];
  data: Record<string, unknown> | undefined;
  message: string | undefined;
  method: string;
} {
  for (const call of logCalls) {
    const [firstArg, secondArg] = call.args;
    const data =
      firstArg && typeof firstArg === "object" && !Array.isArray(firstArg)
        ? (firstArg as Record<string, unknown>)
        : undefined;
    const loggedMessage =
      typeof firstArg === "string"
        ? firstArg
        : typeof secondArg === "string"
          ? secondArg
          : undefined;

    if (loggedMessage === message) {
      return {
        method: call.method,
        args: call.args,
        data,
        message: loggedMessage,
      };
    }
  }

  throw new Error(`Missing log call for message: ${message}`);
}

function expectFailureDiagnosticLog(params: {
  candidateCount: number;
  candidateSources: string[];
  candidateUrls: string[];
  invalidSignature: string;
  webhookKind: string;
}): void {
  const failureLog = findLogCall("Twilio webhook signature validation failed");

  expect(failureLog.method).toBe("warn");
  expect(failureLog.data).toMatchObject({
    webhookKind: params.webhookKind,
    authTokenConfigured: true,
    candidateCount: params.candidateCount,
    candidateSources: params.candidateSources,
    candidateUrls: params.candidateUrls,
  });

  const serializedLogs = JSON.stringify(logCalls);
  expect(serializedLogs).not.toContain(params.invalidSignature);
  expect(serializedLogs).not.toContain(AUTH_TOKEN);
}

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeProxyRequireAuth: true,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    trustProxy: false,
    ...overrides,
  };
  return merged;
}

/** Create mock caches for Twilio webhook tests. */
function makeCaches(
  opts: {
    authToken?: string;
    ingressEnabled?: boolean;
    ingressUrl?: string;
  } = {},
) {
  const {
    authToken = AUTH_TOKEN,
    ingressEnabled,
    ingressUrl,
  } = opts;
  const credentials = {
    get: async (key: string, _opts?: { force?: boolean }) => {
      if (key === credentialKey("twilio", "auth_token")) return authToken;
      return undefined;
    },
    invalidate: () => {},
  } as unknown as CredentialCache;
  const configFile = {
    getString: (section: string, key: string) => {
      if (section === "ingress" && key === "publicBaseUrl") return ingressUrl;
      return undefined;
    },
    getBoolean: (section: string, key: string) => {
      if (section === "ingress" && key === "enabled") return ingressEnabled;
      return undefined;
    },
    getRecord: () => undefined,
    refreshNow: () => {},
  } as unknown as ConfigFileCache;
  return { credentials, configFile };
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
  test("rejects GET requests with 405", async () => {
    const handler = createTwilioVoiceWebhookHandler(makeConfig(), makeCaches());
    const req = new Request("http://localhost:7830/webhooks/twilio/voice", {
      method: "GET",
    });
    const res = await handler(req);
    expect(res.status).toBe(405);
  });

  test("rejects missing signature with 403", async () => {
    const handler = createTwilioVoiceWebhookHandler(makeConfig(), makeCaches());
    const req = new Request("http://localhost:7830/webhooks/twilio/voice", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "CallSid=CA123&CallStatus=ringing",
    });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  test("rejects invalid signature with 403", async () => {
    const handler = createTwilioVoiceWebhookHandler(makeConfig(), makeCaches());
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
      makeConfig(),
      makeCaches({ authToken: undefined }),
    );
    const req = new Request("http://localhost:7830/webhooks/twilio/voice", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "CallSid=CA123",
    });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  test("rejects while public ingress is disabled", async () => {
    const handler = createTwilioVoiceWebhookHandler(
      makeConfig(),
      makeCaches({ ingressEnabled: false }),
    );
    const url = "http://localhost:7830/webhooks/twilio/voice";
    const req = buildSignedRequest(url, { From: "+15550100" }, AUTH_TOKEN);

    const res = await handler(req);

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("forwards valid signed request to runtime and returns response", async () => {
    const twiml = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
    fetchMock = mock(
      async () =>
        new Response(twiml, {
          status: 200,
          headers: { "Content-Type": "text/xml" },
        }),
    );

    const handler = createTwilioVoiceWebhookHandler(makeConfig(), makeCaches());
    const url =
      "http://localhost:7830/webhooks/twilio/voice?callSessionId=sess-1";
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

  test("rejects unmapped inbound call with TwiML Reject when unmappedPolicy is reject", async () => {
    const handler = createTwilioVoiceWebhookHandler(makeConfig(), makeCaches());
    const url = "http://localhost:7830/webhooks/twilio/voice";
    const params = { CallSid: "CA123" };
    const req = buildSignedRequest(url, params, AUTH_TOKEN);

    const res = await handler(req);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<Reject");
  });

  test("returns 502 when runtime is unreachable (outbound call)", async () => {
    fetchMock = mock(async () => {
      throw new Error("Connection refused");
    });

    const handler = createTwilioVoiceWebhookHandler(makeConfig(), makeCaches());
    // Use callSessionId to simulate an outbound call that bypasses routing
    const url =
      "http://localhost:7830/webhooks/twilio/voice?callSessionId=sess-1";
    const params = { CallSid: "CA123" };
    const req = buildSignedRequest(url, params, AUTH_TOKEN);

    const res = await handler(req);
    expect(res.status).toBe(502);
  });

  test("rejects oversized payload via Content-Length header", async () => {
    const handler = createTwilioVoiceWebhookHandler(
      makeConfig({ maxWebhookPayloadBytes: 100 }),
      makeCaches(),
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
      makeCaches(),
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
  test("rejects invalid signature with 403", async () => {
    const handler = createTwilioStatusWebhookHandler(
      makeConfig(),
      makeCaches(),
    );
    const invalidSignature = "bad";
    const req = new Request("http://localhost:7830/webhooks/twilio/status", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": invalidSignature,
      },
      body: "CallSid=CA123&CallStatus=completed",
    });
    const res = await handler(req);
    expect(res.status).toBe(403);
    expectFailureDiagnosticLog({
      webhookKind: "status",
      invalidSignature,
      candidateCount: 1,
      candidateSources: ["raw_request"],
      candidateUrls: ["http://localhost:7830/webhooks/twilio/status"],
    });
  });

  test("forwards valid signed request to runtime", async () => {
    fetchMock = mock(async () => new Response(null, { status: 200 }));

    const handler = createTwilioStatusWebhookHandler(
      makeConfig(),
      makeCaches(),
    );
    const url = "http://localhost:7830/webhooks/twilio/status";
    const params = { CallSid: "CA123", CallStatus: "completed" };
    const req = buildSignedRequest(url, params, AUTH_TOKEN);

    const res = await handler(req);
    expect(res.status).toBe(200);

    const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(calledUrl).toContain("/v1/internal/twilio/status");
  });

  test("returns 502 when runtime returns error", async () => {
    fetchMock = mock(async () => {
      throw new Error("Runtime down");
    });

    const handler = createTwilioStatusWebhookHandler(
      makeConfig(),
      makeCaches(),
    );
    const url = "http://localhost:7830/webhooks/twilio/status";
    const params = { CallSid: "CA123", CallStatus: "completed" };
    const req = buildSignedRequest(url, params, AUTH_TOKEN);

    const res = await handler(req);
    expect(res.status).toBe(502);
  });
});

describe("Twilio connect-action webhook", () => {
  test("rejects invalid signature with 403", async () => {
    const handler = createTwilioConnectActionWebhookHandler(
      makeConfig(),
      makeCaches(),
    );
    const invalidSignature = "wrong";
    const req = new Request(
      "http://localhost:7830/webhooks/twilio/connect-action",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Twilio-Signature": invalidSignature,
        },
        body: "CallSid=CA123",
      },
    );
    const res = await handler(req);
    expect(res.status).toBe(403);
    expectFailureDiagnosticLog({
      webhookKind: "connect-action",
      invalidSignature,
      candidateCount: 1,
      candidateSources: ["raw_request"],
      candidateUrls: ["http://localhost:7830/webhooks/twilio/connect-action"],
    });
  });

  test("forwards valid signed request to runtime", async () => {
    const twiml = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
    fetchMock = mock(
      async () =>
        new Response(twiml, {
          status: 200,
          headers: { "Content-Type": "text/xml" },
        }),
    );

    const handler = createTwilioConnectActionWebhookHandler(
      makeConfig(),
      makeCaches(),
    );
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
  test("validates signature against configured publicBaseUrl", async () => {
    fetchMock = mock(
      async () =>
        new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
          status: 200,
          headers: { "Content-Type": "text/xml" },
        }),
    );

    const publicBaseUrl = "https://public.example.com";
    const handler = createTwilioVoiceWebhookHandler(
      makeConfig(),
      makeCaches({
        ingressUrl: publicBaseUrl,
      }),
    );

    const localUrl =
      "http://localhost:7830/webhooks/twilio/voice?callSessionId=sig-test";
    const publicUrl =
      publicBaseUrl + "/webhooks/twilio/voice?callSessionId=sig-test";
    const params = { CallSid: "CA123" };
    const signature = computeSignature(publicUrl, params, AUTH_TOKEN);
    const req = new Request(localUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": signature,
      },
      body: new URLSearchParams(params).toString(),
    });

    const res = await handler(req);
    expect(res.status).toBe(200);

    const successLog = findLogCall("Twilio webhook signature validated");
    expect(successLog.method).toBe("info");
    expect(successLog.data).toMatchObject({
      webhookKind: "voice",
      validatedCandidateSource: "configured_ingress",
      validatedCandidateUrl: publicUrl,
      candidateCount: 2,
      candidateSources: ["configured_ingress", "raw_request"],
      candidateUrls: [publicUrl, localUrl],
    });
  });

  test("validates signature against ingressPublicBaseUrl when configured", async () => {
    const twiml = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
    fetchMock = mock(
      async () =>
        new Response(twiml, {
          status: 200,
          headers: { "Content-Type": "text/xml" },
        }),
    );

    const publicBaseUrl = "https://public.example.com";
    const config = makeConfig();
    const handler = createTwilioVoiceWebhookHandler(
      config,
      makeCaches({ ingressUrl: publicBaseUrl }),
    );

    // Use callSessionId to bypass inbound routing — this test is about signature validation
    const localUrl =
      "http://localhost:7830/webhooks/twilio/voice?callSessionId=sig-test";
    const publicUrl =
      publicBaseUrl + "/webhooks/twilio/voice?callSessionId=sig-test";
    const params = { CallSid: "CA123" };
    const invalidSignature = "invalid-canonical-signature";

    const invalidReq = new Request(localUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": invalidSignature,
      },
      body: new URLSearchParams(params).toString(),
    });

    const invalidRes = await handler(invalidReq);
    expect(invalidRes.status).toBe(403);
    expectFailureDiagnosticLog({
      webhookKind: "voice",
      invalidSignature,
      candidateCount: 2,
      candidateSources: ["configured_ingress", "raw_request"],
      candidateUrls: [publicUrl, localUrl],
    });

    logCalls.length = 0;

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

    const successLog = findLogCall("Twilio webhook signature validated");
    expect(successLog.method).toBe("info");
    expect(successLog.data).toMatchObject({
      webhookKind: "voice",
      validatedCandidateSource: "configured_ingress",
      validatedCandidateUrl: publicUrl,
      candidateCount: 2,
      candidateSources: ["configured_ingress", "raw_request"],
      candidateUrls: [publicUrl, localUrl],
    });
  });

  test("accepts when signature matches raw request URL even with public URL configured", async () => {
    fetchMock = mock(
      async () =>
        new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
          status: 200,
          headers: { "Content-Type": "text/xml" },
        }),
    );

    const publicBaseUrl = "https://public.example.com";
    const config = makeConfig();
    const handler = createTwilioVoiceWebhookHandler(
      config,
      makeCaches({ ingressUrl: publicBaseUrl }),
    );

    // Use callSessionId to bypass inbound routing — this test is about signature validation
    const localUrl =
      "http://localhost:7830/webhooks/twilio/voice?callSessionId=sig-test";
    const publicUrl =
      publicBaseUrl + "/webhooks/twilio/voice?callSessionId=sig-test";
    const params = { CallSid: "CA123" };
    const invalidSignature = "invalid-raw-fallback-signature";

    const invalidReq = new Request(localUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": invalidSignature,
      },
      body: new URLSearchParams(params).toString(),
    });

    const invalidRes = await handler(invalidReq);
    expect(invalidRes.status).toBe(403);
    expectFailureDiagnosticLog({
      webhookKind: "voice",
      invalidSignature,
      candidateCount: 2,
      candidateSources: ["configured_ingress", "raw_request"],
      candidateUrls: [publicUrl, localUrl],
    });

    logCalls.length = 0;

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

    const successLog = findLogCall(
      "Twilio signature validated against raw request URL fallback — " +
        "ingress.publicBaseUrl may be stale or mismatched with the actual webhook registration",
    );
    expect(successLog.method).toBe("warn");
    expect(successLog.data).toMatchObject({
      webhookKind: "voice",
      validatedCandidateSource: "raw_request",
      validatedCandidateUrl: localUrl,
      candidateCount: 2,
      candidateSources: ["configured_ingress", "raw_request"],
      candidateUrls: [publicUrl, localUrl],
    });
  });

  test("accepts signature from forwarded public URL headers when configured URL is stale", async () => {
    fetchMock = mock(
      async () =>
        new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
          status: 200,
          headers: { "Content-Type": "text/xml" },
        }),
    );

    const staleConfiguredBase = "https://stale.example.com";
    const config = makeConfig();
    const handler = createTwilioVoiceWebhookHandler(
      config,
      makeCaches({ ingressUrl: staleConfiguredBase }),
    );

    // Use callSessionId to bypass inbound routing — this test is about signature validation
    const localUrl =
      "http://localhost:7830/webhooks/twilio/voice?callSessionId=sig-test";
    const forwardedBase = "https://fresh-tunnel.example.com";
    const signedPublicUrl = `${forwardedBase}/webhooks/twilio/voice?callSessionId=sig-test`;
    const params = { CallSid: "CA123" };
    const invalidSignature = "invalid-forwarded-signature";
    const invalidReq = new Request(localUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": invalidSignature,
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "fresh-tunnel.example.com",
      },
      body: new URLSearchParams(params).toString(),
    });

    const invalidRes = await handler(invalidReq);
    expect(invalidRes.status).toBe(403);
    expectFailureDiagnosticLog({
      webhookKind: "voice",
      invalidSignature,
      candidateCount: 3,
      candidateSources: [
        "configured_ingress",
        "forwarded_headers",
        "raw_request",
      ],
      candidateUrls: [
        staleConfiguredBase + "/webhooks/twilio/voice?callSessionId=sig-test",
        signedPublicUrl,
        localUrl,
      ],
    });

    logCalls.length = 0;

    const req = buildSignedRequest(signedPublicUrl, params, AUTH_TOKEN, {
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "fresh-tunnel.example.com",
    });

    // Gateway receives the local URL from the tunnel, but should still
    // validate against the forwarded public URL headers.
    const tunneledReq = new Request(localUrl, {
      method: req.method,
      headers: req.headers,
      body: await req.text(),
    });

    const res = await handler(tunneledReq);
    expect(res.status).toBe(200);

    const successLog = findLogCall("Twilio webhook signature validated");
    expect(successLog.method).toBe("info");
    expect(successLog.data).toMatchObject({
      webhookKind: "voice",
      validatedCandidateSource: "forwarded_headers",
      validatedCandidateUrl: signedPublicUrl,
      candidateCount: 3,
      candidateSources: [
        "configured_ingress",
        "forwarded_headers",
        "raw_request",
      ],
      candidateUrls: [
        staleConfiguredBase + "/webhooks/twilio/voice?callSessionId=sig-test",
        signedPublicUrl,
        localUrl,
      ],
    });
  });
});

describe("Twilio webhook force retry", () => {
  test("refreshes Twilio-specific ingress URL before retrying signature validation", async () => {
    fetchMock = mock(
      async () =>
        new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
          status: 200,
          headers: { "Content-Type": "text/xml" },
        }),
    );

    let refreshCount = 0;
    const credentials = {
      get: async () => AUTH_TOKEN,
      invalidate: () => {},
    } as unknown as CredentialCache;

    const staleTwilioBaseUrl = "https://stale-twilio.example.com";
    const freshBaseUrl = "https://fresh-twilio.example.com";
    const configFile = {
      getString: (section: string, key: string) => {
        if (section !== "ingress") return undefined;
        if (key === "publicBaseUrl") {
          return refreshCount > 0 ? freshBaseUrl : staleTwilioBaseUrl;
        }
        return undefined;
      },
      getRecord: () => undefined,
      refreshNow: () => {
        refreshCount++;
      },
    } as unknown as ConfigFileCache;

    const handler = createTwilioVoiceWebhookHandler(makeConfig(), {
      credentials,
      configFile,
    });

    const localUrl =
      "http://localhost:7830/webhooks/twilio/voice?callSessionId=sess-refresh";
    const freshTwilioUrl =
      freshBaseUrl + "/webhooks/twilio/voice?callSessionId=sess-refresh";
    const params = { CallSid: "CA123" };
    const signature = computeSignature(freshTwilioUrl, params, AUTH_TOKEN);
    const req = new Request(localUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": signature,
      },
      body: new URLSearchParams(params).toString(),
    });

    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(refreshCount).toBe(1);
  });

  test("succeeds after force-refreshing a missing auth token", async () => {
    const twiml = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
    fetchMock = mock(
      async () =>
        new Response(twiml, {
          status: 200,
          headers: { "Content-Type": "text/xml" },
        }),
    );

    // First get() returns undefined; second get({ force: true }) returns the token
    let callCount = 0;
    const credentials = {
      get: async (_key: string, opts?: { force?: boolean }) => {
        callCount++;
        if (callCount === 1 && !opts?.force) return undefined;
        return AUTH_TOKEN;
      },
      invalidate: () => {},
    } as unknown as CredentialCache;

    const configFile = {
      getString: (section: string, key: string) => {
        if (section === "ingress" && key === "publicBaseUrl") return undefined;
        return undefined;
      },
      getRecord: () => undefined,
      refreshNow: () => {},
    } as unknown as ConfigFileCache;

    const handler = createTwilioVoiceWebhookHandler(makeConfig(), {
      credentials,
      configFile,
    });

    const url =
      "http://localhost:7830/webhooks/twilio/voice?callSessionId=sess-force";
    const params = { CallSid: "CA123" };
    const req = buildSignedRequest(url, params, AUTH_TOKEN);

    const res = await handler(req);
    expect(res.status).toBe(200);
    // The credential cache should have been called at least twice (initial + force)
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  test("returns 403 when force refresh also returns undefined", async () => {
    // Both get() and get({ force: true }) return undefined
    const credentials = {
      get: async () => undefined,
      invalidate: () => {},
    } as unknown as CredentialCache;

    const configFile = {
      getString: () => undefined,
      getRecord: () => undefined,
      refreshNow: () => {},
    } as unknown as ConfigFileCache;

    const handler = createTwilioVoiceWebhookHandler(makeConfig(), {
      credentials,
      configFile,
    });

    const url = "http://localhost:7830/webhooks/twilio/voice";
    const req = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "CallSid=CA123",
    });

    const res = await handler(req);
    expect(res.status).toBe(403);
  });
});
