import { describe, test, expect, mock, afterEach } from "bun:test";
import {
  forwardToRuntime,
  downloadAttachment,
  forwardTwilioVoiceWebhook,
  forwardTwilioStatusWebhook,
  forwardTwilioConnectActionWebhook,
} from "../runtime/client.js";
import type { RuntimeAttachmentMeta } from "../runtime/client.js";
import type { GatewayConfig } from "../config.js";

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
    runtimeBearerToken: undefined,
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
    ...overrides,
  };
  if (merged.runtimeGatewayOriginSecret === undefined) {
    merged.runtimeGatewayOriginSecret = merged.runtimeBearerToken;
  }
  return merged;
}

const payload = {
  sourceChannel: "telegram",
  externalChatId: "99001",
  externalMessageId: "123",
  content: "Hello",
  senderName: "Test User",
};

const testAttachment: RuntimeAttachmentMeta = {
  id: "att-1",
  filename: "chart.png",
  mimeType: "image/png",
  sizeBytes: 1024,
  kind: "generated_image",
};

const successBody = {
  accepted: true,
  duplicate: false,
  eventId: "evt-1",
  assistantMessage: {
    id: "msg-1",
    role: "assistant" as const,
    content: "Hi there!",
    timestamp: new Date().toISOString(),
    attachments: [testAttachment],
  },
};

function mockFetch(fn: (...args: Parameters<typeof fetch>) => Promise<Response>) {
  const m = mock(fn);
  Object.assign(m, { preconnect: () => {} });
  globalThis.fetch = m as unknown as typeof fetch;
  return m;
}

describe("forwardToRuntime", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("successful forward returns runtime response", async () => {
    mockFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify(successBody), { status: 200 }),
      ),
    );

    const config = makeConfig();
    const result = await forwardToRuntime(config, "assistant-a", payload);
    expect(result.accepted).toBe(true);
    expect(result.eventId).toBe("evt-1");
    expect(result.assistantMessage?.content).toBe("Hi there!");
  });

  test("4xx error throws immediately without retry", async () => {
    const fetchMock = mockFetch(() =>
      Promise.resolve(new Response("Bad request", { status: 400 })),
    );

    const config = makeConfig();
    await expect(
      forwardToRuntime(config, "assistant-a", payload),
    ).rejects.toThrow("Runtime returned 400");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("5xx error retries and eventually succeeds", async () => {
    const config = makeConfig();
    const expectedUrl = `${config.assistantRuntimeBaseUrl}/v1/assistants/assistant-a/channels/inbound`;
    let inboundCallCount = 0;
    const fetchMock = mockFetch((input) => {
      const calledUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (calledUrl === expectedUrl) {
        inboundCallCount++;
      }

      if (inboundCallCount <= 2) {
        return Promise.resolve(
          new Response("Internal error", { status: 500 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(successBody), { status: 200 }),
      );
    });

    const result = await forwardToRuntime(config, "assistant-a", payload);
    expect(result.accepted).toBe(true);
    const callsToInboundRoute = fetchMock.mock.calls.filter((call) => {
      const calledUrl = call[0];
      return typeof calledUrl === "string" && calledUrl === expectedUrl;
    });
    expect(callsToInboundRoute).toHaveLength(3);
  });

  test("5xx error exhausts retries and throws", async () => {
    mockFetch(() =>
      Promise.resolve(new Response("Server error", { status: 500 })),
    );

    const config = makeConfig();
    await expect(
      forwardToRuntime(config, "assistant-a", payload),
    ).rejects.toThrow("Runtime returned 500");
  });

  test("response includes typed attachment metadata", async () => {
    mockFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify(successBody), { status: 200 }),
      ),
    );

    const config = makeConfig();
    const result = await forwardToRuntime(config, "assistant-a", payload);
    const attachments = result.assistantMessage?.attachments ?? [];
    expect(attachments).toHaveLength(1);
    expect(attachments[0].id).toBe("att-1");
    expect(attachments[0].filename).toBe("chart.png");
    expect(attachments[0].mimeType).toBe("image/png");
    expect(attachments[0].sizeBytes).toBe(1024);
    expect(attachments[0].kind).toBe("generated_image");
  });

  test("sends Authorization header when runtimeBearerToken is configured", async () => {
    const fetchMock = mockFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify(successBody), { status: 200 }),
      ),
    );

    const config = makeConfig({ runtimeBearerToken: "my-secret-token" });
    await forwardToRuntime(config, "assistant-a", payload);

    const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    const headers = calledInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer my-secret-token");
  });

  test("omits Authorization header when runtimeBearerToken is undefined", async () => {
    const fetchMock = mockFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify(successBody), { status: 200 }),
      ),
    );

    const config = makeConfig();
    await forwardToRuntime(config, "assistant-a", payload);

    const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    const headers = calledInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });
});

describe("downloadAttachment", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("downloads attachment payload with base64 data", async () => {
    const attachmentPayload = {
      id: "att-1",
      filename: "chart.png",
      mimeType: "image/png",
      sizeBytes: 1024,
      kind: "generated_image",
      data: "iVBORw0KGgo=",
    };

    const fetchMock = mockFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify(attachmentPayload), { status: 200 }),
      ),
    );

    const config = makeConfig();
    const result = await downloadAttachment(config, "assistant-a", "att-1");
    expect(result.id).toBe("att-1");
    expect(result.filename).toBe("chart.png");
    expect(result.data).toBe("iVBORw0KGgo=");

    const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(calledUrl).toContain("/attachments/att-1");
  });

  test("throws on 404 not found", async () => {
    mockFetch(() =>
      Promise.resolve(
        new Response('{"error":"Attachment not found"}', { status: 404 }),
      ),
    );

    const config = makeConfig();
    await expect(
      downloadAttachment(config, "assistant-a", "nonexistent"),
    ).rejects.toThrow("Attachment download failed (404)");
  });
});

describe("forwardTwilioVoiceWebhook", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends params and originalUrl to runtime internal endpoint", async () => {
    const twiml = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
    const fetchMock = mockFetch(() =>
      Promise.resolve(
        new Response(twiml, {
          status: 200,
          headers: { "Content-Type": "text/xml" },
        }),
      ),
    );

    const config = makeConfig({ runtimeBearerToken: "rt-tok" });
    const params = { CallSid: "CA123", AccountSid: "AC456" };
    const originalUrl = "https://example.com/webhooks/twilio/voice?callSessionId=sess-1";

    const result = await forwardTwilioVoiceWebhook(config, params, originalUrl);
    expect(result.status).toBe(200);
    expect(result.body).toBe(twiml);
    expect(result.headers["Content-Type"]).toBe("text/xml");

    const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(calledUrl).toBe("http://localhost:7821/v1/internal/twilio/voice-webhook");

    const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    const sentBody = JSON.parse(calledInit.body as string);
    expect(sentBody.params).toEqual(params);
    expect(sentBody.originalUrl).toBe(originalUrl);

    const headers = calledInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer rt-tok");
  });
});

describe("forwardTwilioStatusWebhook", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends params to runtime internal status endpoint", async () => {
    const fetchMock = mockFetch(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );

    const config = makeConfig({ runtimeBearerToken: "rt-tok" });
    const params = { CallSid: "CA123", CallStatus: "completed" };

    const result = await forwardTwilioStatusWebhook(config, params);
    expect(result.status).toBe(200);

    const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(calledUrl).toBe("http://localhost:7821/v1/internal/twilio/status");

    const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    const sentBody = JSON.parse(calledInit.body as string);
    expect(sentBody.params).toEqual(params);
  });
});

describe("forwardTwilioConnectActionWebhook", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends params to runtime internal connect-action endpoint", async () => {
    const twiml = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
    const fetchMock = mockFetch(() =>
      Promise.resolve(
        new Response(twiml, {
          status: 200,
          headers: { "Content-Type": "text/xml" },
        }),
      ),
    );

    const config = makeConfig({ runtimeBearerToken: "rt-tok" });
    const params = { CallSid: "CA123" };

    const result = await forwardTwilioConnectActionWebhook(config, params);
    expect(result.status).toBe(200);
    expect(result.body).toBe(twiml);

    const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(calledUrl).toBe("http://localhost:7821/v1/internal/twilio/connect-action");
  });

  test("returns runtime error status and body", async () => {
    mockFetch(() =>
      Promise.resolve(
        new Response('{"error":"Not found"}', { status: 404 }),
      ),
    );

    const config = makeConfig();
    const result = await forwardTwilioConnectActionWebhook(config, { CallSid: "CA999" });
    expect(result.status).toBe(404);
    expect(result.body).toContain("Not found");
  });
});
