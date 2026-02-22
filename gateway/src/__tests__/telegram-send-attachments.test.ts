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

  test("ID-only attachment hydrates metadata from downloaded payload", async () => {
    const calls: string[] = [];

    mockFetch(async (url: string) => {
      calls.push(url);
      if (url.includes("/attachments/att-id-only")) {
        return new Response(
          JSON.stringify({
            id: "att-id-only",
            filename: "downloaded.png",
            mimeType: "image/png",
            sizeBytes: 120,
            kind: "generated_image",
            data: "iVBORw0KGgo=",
          }),
        );
      }
      return new Response(JSON.stringify(telegramOk));
    });

    const config = makeConfig();
    // Only provide `id` — no filename, mimeType, sizeBytes, or kind
    const meta: RuntimeAttachmentMeta = { id: "att-id-only" };

    await sendTelegramAttachments(config, "chat-1", "assistant-a", [meta]);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/attachments/att-id-only");
    // Should use mimeType from downloaded payload to determine it's an image
    expect(calls[1]).toContain("sendPhoto");
  });

  test("ID-only attachment falls back to defaults when download payload also lacks metadata", async () => {
    const calls: string[] = [];

    mockFetch(async (url: string) => {
      calls.push(url);
      if (url.includes("/attachments/att-bare")) {
        return new Response(
          JSON.stringify({
            id: "att-bare",
            data: "AQID", // 3 bytes base64
          }),
        );
      }
      return new Response(JSON.stringify(telegramOk));
    });

    const config = makeConfig();
    const meta: RuntimeAttachmentMeta = { id: "att-bare" };

    await sendTelegramAttachments(config, "chat-1", "assistant-a", [meta]);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/attachments/att-bare");
    // With default mime type (application/octet-stream), should send as document
    expect(calls[1]).toContain("sendDocument");
  });

  test("ID-only attachment skipped when hydrated size exceeds limit", async () => {
    const calls: string[] = [];

    mockFetch(async (url: string) => {
      calls.push(url);
      if (url.includes("/attachments/att-big")) {
        return new Response(
          JSON.stringify({
            id: "att-big",
            filename: "big.bin",
            mimeType: "application/octet-stream",
            sizeBytes: 200,
            kind: "filesystem",
            data: "AQID",
          }),
        );
      }
      return new Response(JSON.stringify(telegramOk));
    });

    const config = makeConfig({ maxAttachmentBytes: 50 });
    // No sizeBytes in meta — will be hydrated from download payload (200 > 50 limit)
    const meta: RuntimeAttachmentMeta = { id: "att-big" };

    await sendTelegramAttachments(config, "chat-1", "assistant-a", [meta]);

    // Should download, discover size exceeds limit, skip, then send failure notice
    expect(calls.filter((u) => u.includes("/attachments/att-big"))).toHaveLength(1);
    expect(calls.filter((u) => u.includes("sendMessage"))).toHaveLength(1);
    expect(calls.filter((u) => u.includes("sendPhoto"))).toHaveLength(0);
    expect(calls.filter((u) => u.includes("sendDocument"))).toHaveLength(0);
  });

  test("ID-only attachment uses id as filename fallback", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    const origMockFetch = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("/attachments/my-attachment-id")) {
        return new Response(
          JSON.stringify({
            id: "my-attachment-id",
            mimeType: "application/pdf",
            sizeBytes: 50,
            data: "JVBER",
          }),
        );
      }
      return new Response(JSON.stringify(telegramOk));
    });
    Object.assign(origMockFetch, { preconnect: () => {} });
    globalThis.fetch = origMockFetch as unknown as typeof fetch;

    const config = makeConfig();
    const meta: RuntimeAttachmentMeta = { id: "my-attachment-id" };

    await sendTelegramAttachments(config, "chat-1", "assistant-a", [meta]);

    expect(calls).toHaveLength(2);
    // Second call is the Telegram API call with FormData
    const telegramCall = calls[1];
    expect(telegramCall.url).toContain("sendDocument");
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
