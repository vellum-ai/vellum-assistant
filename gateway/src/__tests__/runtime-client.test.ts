import { describe, test, expect, mock, afterEach } from "bun:test";
import { forwardToRuntime, downloadAttachment } from "../runtime/client.js";
import type { RuntimeAttachmentMeta } from "../runtime/client.js";
import type { GatewayConfig } from "../config.js";

const makeConfig = (overrides: Partial<GatewayConfig> = {}): GatewayConfig => ({
  telegramBotToken: "tok",
  telegramWebhookSecret: "wh-ver",
  telegramApiBaseUrl: "https://api.telegram.org",
  assistantRuntimeBaseUrl: "http://localhost:7821",
  routingEntries: [],
  defaultAssistantId: undefined,
  unmappedPolicy: "reject",
  port: 7830,
  runtimeBearerToken: undefined,
  runtimeProxyEnabled: false,
  runtimeProxyRequireAuth: true,
  runtimeProxyBearerToken: undefined,
  shutdownDrainMs: 5000,
  runtimeTimeoutMs: 30000,
  runtimeMaxRetries: 2,
  runtimeInitialBackoffMs: 500,
  telegramInitialBackoffMs: 1000,
  telegramMaxRetries: 3,
  telegramTimeoutMs: 15000,
  maxWebhookPayloadBytes: 1048576,
  logFile: { dir: undefined, retentionDays: 30 },
  maxAttachmentBytes: 20971520,
  maxAttachmentConcurrency: 3,
  ...overrides,
});

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

function mockFetch(fn: () => Promise<Response>) {
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
    const result = await forwardToRuntime(config, payload);
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
      forwardToRuntime(config, payload),
    ).rejects.toThrow("Runtime returned 400");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("5xx error retries and eventually succeeds", async () => {
    let callCount = 0;
    mockFetch(() => {
      callCount++;
      if (callCount <= 2) {
        return Promise.resolve(
          new Response("Internal error", { status: 500 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(successBody), { status: 200 }),
      );
    });

    const config = makeConfig();
    const result = await forwardToRuntime(config, payload);
    expect(result.accepted).toBe(true);
    expect(callCount).toBe(3);
  });

  test("5xx error exhausts retries and throws", async () => {
    mockFetch(() =>
      Promise.resolve(new Response("Server error", { status: 500 })),
    );

    const config = makeConfig();
    await expect(
      forwardToRuntime(config, payload),
    ).rejects.toThrow("Runtime returned 500");
  });

  test("response includes typed attachment metadata", async () => {
    mockFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify(successBody), { status: 200 }),
      ),
    );

    const config = makeConfig();
    const result = await forwardToRuntime(config, payload);
    const attachments = result.assistantMessage?.attachments ?? [];
    expect(attachments).toHaveLength(1);
    expect(attachments[0].id).toBe("att-1");
    expect(attachments[0].filename).toBe("chart.png");
    expect(attachments[0].mimeType).toBe("image/png");
    expect(attachments[0].sizeBytes).toBe(1024);
    expect(attachments[0].kind).toBe("generated_image");
  });

  test("uses new /v1/channels/inbound URL (no assistantId in path)", async () => {
    const fetchMock = mockFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify(successBody), { status: 200 }),
      ),
    );

    const config = makeConfig();
    await forwardToRuntime(config, payload);

    const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(calledUrl).toBe("http://localhost:7821/v1/channels/inbound");
  });

  test("sends Authorization header when runtimeBearerToken is configured", async () => {
    const fetchMock = mockFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify(successBody), { status: 200 }),
      ),
    );

    const config = makeConfig({ runtimeBearerToken: "my-secret-token" });
    await forwardToRuntime(config, payload);

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
    await forwardToRuntime(config, payload);

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
    const result = await downloadAttachment(config, "att-1");
    expect(result.id).toBe("att-1");
    expect(result.filename).toBe("chart.png");
    expect(result.data).toBe("iVBORw0KGgo=");

    const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(calledUrl).toBe("http://localhost:7821/v1/attachments/att-1");
  });

  test("throws on 404 not found", async () => {
    mockFetch(() =>
      Promise.resolve(
        new Response('{"error":"Attachment not found"}', { status: 404 }),
      ),
    );

    const config = makeConfig();
    await expect(
      downloadAttachment(config, "nonexistent"),
    ).rejects.toThrow("Attachment download failed (404)");
  });
});
