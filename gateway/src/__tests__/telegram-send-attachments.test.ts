import { describe, test, expect, mock, afterEach } from "bun:test";
import { sendTelegramAttachments } from "../telegram/send.js";
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
  telegramDeliverAuthBypass: false,
  telegramInitialBackoffMs: 1000,
  telegramMaxRetries: 3,
  telegramTimeoutMs: 15000,
  maxWebhookPayloadBytes: 1048576,
  logFile: { dir: undefined, retentionDays: 30 },
  maxAttachmentBytes: 20971520,
  maxAttachmentConcurrency: 3,
  twilioAuthToken: undefined,
  ingressPublicBaseUrl: undefined,
  gatewayInternalBaseUrl: "http://127.0.0.1:7830",
  ...overrides,
});

const telegramOk = { ok: true, result: { message_id: 1 } };

function mockFetch(fn: (url: string, init?: RequestInit) => Promise<Response>) {
  const m = mock(fn);
  Object.assign(m, { preconnect: () => {} });
  globalThis.fetch = m as unknown as typeof fetch;
  return m;
}

describe("sendTelegramAttachments", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends image attachment via sendPhoto", async () => {
    const calls: string[] = [];

    mockFetch(async (url: string) => {
      calls.push(url);
      // Runtime download endpoint
      if (url.includes("/attachments/att-1")) {
        return new Response(
          JSON.stringify({
            id: "att-1",
            filename: "photo.png",
            mimeType: "image/png",
            sizeBytes: 100,
            kind: "generated_image",
            data: "iVBORw0KGgo=",
          }),
        );
      }
      // Telegram sendPhoto
      return new Response(JSON.stringify(telegramOk));
    });

    const config = makeConfig();
    const meta: RuntimeAttachmentMeta = {
      id: "att-1",
      filename: "photo.png",
      mimeType: "image/png",
      sizeBytes: 100,
      kind: "generated_image",
    };

    await sendTelegramAttachments(config, "chat-1", "assistant-a", [meta]);

    // Should have called: 1) runtime download, 2) telegram sendPhoto
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/attachments/att-1");
    expect(calls[1]).toContain("sendPhoto");
  });

  test("sends non-image attachment via sendDocument", async () => {
    const calls: string[] = [];

    mockFetch(async (url: string) => {
      calls.push(url);
      if (url.includes("/attachments/att-2")) {
        return new Response(
          JSON.stringify({
            id: "att-2",
            filename: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 200,
            kind: "filesystem",
            data: "JVBER",
          }),
        );
      }
      return new Response(JSON.stringify(telegramOk));
    });

    const config = makeConfig();
    const meta: RuntimeAttachmentMeta = {
      id: "att-2",
      filename: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 200,
      kind: "filesystem",
    };

    await sendTelegramAttachments(config, "chat-1", "assistant-a", [meta]);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/attachments/att-2");
    expect(calls[1]).toContain("sendDocument");
  });

  test("skips oversized attachments and sends failure notice", async () => {
    const calls: string[] = [];

    mockFetch(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(telegramOk));
    });

    const config = makeConfig({ maxAttachmentBytes: 50 });
    const meta: RuntimeAttachmentMeta = {
      id: "att-3",
      filename: "huge.zip",
      mimeType: "application/zip",
      sizeBytes: 100, // exceeds 50 byte limit
      kind: "filesystem",
    };

    await sendTelegramAttachments(config, "chat-1", "assistant-a", [meta]);

    // Should have sent only the failure notice via sendMessage
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("sendMessage");
  });

  test("downloads via assistant-less path when assistantId is undefined", async () => {
    const calls: string[] = [];

    mockFetch(async (url: string) => {
      calls.push(url);
      if (url.includes("/attachments/att-no-assist")) {
        return new Response(
          JSON.stringify({
            id: "att-no-assist",
            filename: "image.jpg",
            mimeType: "image/jpeg",
            sizeBytes: 80,
            kind: "generated_image",
            data: "/9j/4AAQ",
          }),
        );
      }
      return new Response(JSON.stringify(telegramOk));
    });

    const config = makeConfig();
    const meta: RuntimeAttachmentMeta = {
      id: "att-no-assist",
      filename: "image.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 80,
      kind: "generated_image",
    };

    await sendTelegramAttachments(config, "chat-1", undefined, [meta]);

    expect(calls).toHaveLength(2);
    // Should use /v1/attachments/ path (no assistantId in URL)
    const downloadUrl = calls[0];
    expect(downloadUrl).toContain("/v1/attachments/att-no-assist");
    expect(downloadUrl).not.toContain("/assistants/");
    expect(calls[1]).toContain("sendPhoto");
  });

  test("continues sending remaining attachments on individual failure", async () => {
    const calls: string[] = [];

    mockFetch(async (url: string) => {
      calls.push(url);
      // First attachment download fails
      if (url.includes("/attachments/att-fail")) {
        return new Response('{"error":"not found"}', { status: 404 });
      }
      // Second attachment succeeds
      if (url.includes("/attachments/att-ok")) {
        return new Response(
          JSON.stringify({
            id: "att-ok",
            filename: "good.png",
            mimeType: "image/png",
            sizeBytes: 50,
            kind: "generated_image",
            data: "iVBORw0KGgo=",
          }),
        );
      }
      return new Response(JSON.stringify(telegramOk));
    });

    const config = makeConfig();
    const attachments: RuntimeAttachmentMeta[] = [
      { id: "att-fail", filename: "bad.png", mimeType: "image/png", sizeBytes: 50, kind: "generated_image" },
      { id: "att-ok", filename: "good.png", mimeType: "image/png", sizeBytes: 50, kind: "generated_image" },
    ];

    await sendTelegramAttachments(config, "chat-1", "assistant-a", attachments);

    // Should have: download att-fail (fail), download att-ok, sendPhoto for att-ok, sendMessage for notice
    expect(calls.filter((u) => u.includes("sendPhoto"))).toHaveLength(1);
    expect(calls.filter((u) => u.includes("sendMessage"))).toHaveLength(1);
  });
});
