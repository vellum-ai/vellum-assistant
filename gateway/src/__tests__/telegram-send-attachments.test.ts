import { describe, test, expect, mock, afterEach } from "bun:test";
import type { RuntimeAttachmentMeta } from "../runtime/client.js";
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

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

const { sendTelegramAttachments } = await import("../telegram/send.js");

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeProxyEnabled: false,
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

/** Mock credential cache that provides a test bot token. */
const testCreds: CredentialCache = {
  get: async (key: string) => {
    if (key === credentialKey("telegram", "bot_token")) return "test-bot-token";
    return undefined;
  },
  invalidate: () => {},
} as unknown as CredentialCache;

const testConfigFile: ConfigFileCache = {
  getNumber: (_section: string, field: string) => {
    if (field === "maxRetries") return 0;
    return undefined;
  },
  getString: () => undefined,
  getBoolean: () => undefined,
  getRecord: () => undefined,
} as unknown as ConfigFileCache;

const testOpts = { credentials: testCreds, configFile: testConfigFile };

const telegramOk = { ok: true, result: { message_id: 1 } };

describe("sendTelegramAttachments", () => {
  afterEach(() => {
    fetchMock = mock(async () => new Response());
  });

  test("sends image attachment via sendPhoto", async () => {
    const calls: string[] = [];

    fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
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

    await sendTelegramAttachments(config, "chat-1", [meta], testOpts);

    // Should have called: 1) runtime download, 2) telegram sendPhoto
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/attachments/att-1");
    expect(calls[1]).toContain("sendPhoto");
  });

  test("sends non-image attachment via sendDocument", async () => {
    const calls: string[] = [];

    fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
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

    await sendTelegramAttachments(config, "chat-1", [meta], testOpts);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/attachments/att-2");
    expect(calls[1]).toContain("sendDocument");
  });

  test("skips oversized attachments and sends failure notice", async () => {
    const calls: string[] = [];

    fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push(url);
      return new Response(JSON.stringify(telegramOk));
    });

    const config = makeConfig({
      maxAttachmentBytes: {
        telegram: 50,
        slack: 50,
        whatsapp: 50,
        default: 50,
      },
    });
    const meta: RuntimeAttachmentMeta = {
      id: "att-3",
      filename: "huge.zip",
      mimeType: "application/zip",
      sizeBytes: 100, // exceeds 50 byte limit
      kind: "filesystem",
    };

    await sendTelegramAttachments(config, "chat-1", [meta], testOpts);

    // Should have sent only the failure notice via sendMessage
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("sendMessage");
  });

  test("downloads via flat /v1/attachments/ path", async () => {
    const calls: string[] = [];

    fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
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

    await sendTelegramAttachments(config, "chat-1", [meta], testOpts);

    expect(calls).toHaveLength(2);
    // Should use /v1/attachments/ path (no assistantId in URL)
    const downloadUrl = calls[0];
    expect(downloadUrl).toContain("/v1/attachments/att-no-assist");
    expect(downloadUrl).not.toContain("/assistants/");
    expect(calls[1]).toContain("sendPhoto");
  });

  test("ID-only attachment hydrates metadata from downloaded payload", async () => {
    const calls: string[] = [];

    fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
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

    await sendTelegramAttachments(config, "chat-1", [meta], testOpts);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/attachments/att-id-only");
    // Should use mimeType from downloaded payload to determine it's an image
    expect(calls[1]).toContain("sendPhoto");
  });

  test("ID-only attachment falls back to defaults when download payload also lacks metadata", async () => {
    const calls: string[] = [];

    fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
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

    await sendTelegramAttachments(config, "chat-1", [meta], testOpts);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/attachments/att-bare");
    // With default mime type (application/octet-stream), should send as document
    expect(calls[1]).toContain("sendDocument");
  });

  test("ID-only attachment skipped when hydrated size exceeds limit", async () => {
    const calls: string[] = [];

    fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
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

    const config = makeConfig({
      maxAttachmentBytes: {
        telegram: 50,
        slack: 50,
        whatsapp: 50,
        default: 50,
      },
    });
    // No sizeBytes in meta — will be hydrated from download payload (200 > 50 limit)
    const meta: RuntimeAttachmentMeta = { id: "att-big" };

    await sendTelegramAttachments(config, "chat-1", [meta], testOpts);

    // Should download, discover size exceeds limit, skip, then send failure notice
    expect(
      calls.filter((u) => u.includes("/attachments/att-big")),
    ).toHaveLength(1);
    expect(calls.filter((u) => u.includes("sendMessage"))).toHaveLength(1);
    expect(calls.filter((u) => u.includes("sendPhoto"))).toHaveLength(0);
    expect(calls.filter((u) => u.includes("sendDocument"))).toHaveLength(0);
  });

  test("ID-only attachment uses id as filename fallback", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const urlStr =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        calls.push({ url: urlStr, init });
        if (urlStr.includes("/attachments/my-attachment-id")) {
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
      },
    );

    const config = makeConfig();
    const meta: RuntimeAttachmentMeta = { id: "my-attachment-id" };

    await sendTelegramAttachments(config, "chat-1", [meta], testOpts);

    expect(calls).toHaveLength(2);
    // Second call is the Telegram API call with FormData
    const telegramCall = calls[1];
    expect(telegramCall.url).toContain("sendDocument");
  });

  test("full-metadata payload still works (backward compatibility)", async () => {
    const calls: string[] = [];

    fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push(url);
      if (url.includes("/attachments/att-full")) {
        return new Response(
          JSON.stringify({
            id: "att-full",
            filename: "photo.jpg",
            mimeType: "image/jpeg",
            sizeBytes: 100,
            kind: "generated_image",
            data: "/9j/4AAQ",
          }),
        );
      }
      return new Response(JSON.stringify(telegramOk));
    });

    const config = makeConfig();
    const meta: RuntimeAttachmentMeta = {
      id: "att-full",
      filename: "photo.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 100,
      kind: "generated_image",
    };

    await sendTelegramAttachments(config, "chat-1", [meta], testOpts);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/attachments/att-full");
    expect(calls[1]).toContain("sendPhoto");
  });

  test("continues sending remaining attachments on individual failure", async () => {
    const calls: string[] = [];

    fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
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
      {
        id: "att-fail",
        filename: "bad.png",
        mimeType: "image/png",
        sizeBytes: 50,
        kind: "generated_image",
      },
      {
        id: "att-ok",
        filename: "good.png",
        mimeType: "image/png",
        sizeBytes: 50,
        kind: "generated_image",
      },
    ];

    await sendTelegramAttachments(config, "chat-1", attachments, testOpts);

    // Should have: download att-fail (fail), download att-ok, sendPhoto for att-ok, sendMessage for notice
    expect(calls.filter((u) => u.includes("sendPhoto"))).toHaveLength(1);
    expect(calls.filter((u) => u.includes("sendMessage"))).toHaveLength(1);
  });
});
