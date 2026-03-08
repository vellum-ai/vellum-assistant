import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";

const handleInboundMock = mock(() =>
  Promise.resolve({ forwarded: true, rejected: false }),
);
const resetConversationMock = mock(() => Promise.resolve());
const uploadAttachmentMock = mock(() =>
  Promise.resolve({ id: "att-uploaded-1" }),
);
const sendWhatsAppReplyMock = mock(() => Promise.resolve());
const markWhatsAppMessageReadMock = mock(() => Promise.resolve());
const downloadWhatsAppFileMock = mock(() =>
  Promise.resolve({
    filename: "photo.jpg",
    mimeType: "image/jpeg",
    data: "base64data",
  }),
);
const normalizeWhatsAppWebhookMock = mock(
  () =>
    [] as Array<{ event: Record<string, unknown>; whatsappMessageId: string }>,
);
const verifyWhatsAppWebhookSignatureMock = mock(() => true);

class MockAttachmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentValidationError";
  }
}

class MockWhatsAppNonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppNonRetryableError";
  }
}

mock.module("../../handlers/handle-inbound.js", () => ({
  handleInbound: handleInboundMock,
}));

mock.module("../../runtime/client.js", () => ({
  resetConversation: resetConversationMock,
  uploadAttachment: uploadAttachmentMock,
  AttachmentValidationError: MockAttachmentValidationError,
  CircuitBreakerOpenError: class extends Error {},
}));

mock.module("../../whatsapp/download.js", () => ({
  downloadWhatsAppFile: downloadWhatsAppFileMock,
}));

mock.module("../../whatsapp/send.js", () => ({
  sendWhatsAppReply: sendWhatsAppReplyMock,
  sendWhatsAppAttachments: mock(() =>
    Promise.resolve({ allFailed: false, failureCount: 0, totalCount: 0 }),
  ),
}));

mock.module("../../whatsapp/api.js", () => ({
  markWhatsAppMessageRead: markWhatsAppMessageReadMock,
  WhatsAppNonRetryableError: MockWhatsAppNonRetryableError,
}));

mock.module("../../whatsapp/normalize.js", () => ({
  normalizeWhatsAppWebhook: normalizeWhatsAppWebhookMock,
}));

mock.module("../../whatsapp/verify.js", () => ({
  verifyWhatsAppWebhookSignature: verifyWhatsAppWebhookSignatureMock,
}));

const { createWhatsAppWebhookHandler } = await import("./whatsapp-webhook.js");

const baseConfig: GatewayConfig = {
  assistantRuntimeBaseUrl: "http://localhost:7821",
  defaultAssistantId: "ast-default",
  gatewayInternalBaseUrl: "http://127.0.0.1:7830",
  logFile: { dir: undefined, retentionDays: 30 },
  maxAttachmentBytes: 20 * 1024 * 1024,
  maxAttachmentConcurrency: 3,
  maxWebhookPayloadBytes: 1024 * 1024,
  port: 7830,
  routingEntries: [],
  runtimeInitialBackoffMs: 500,
  runtimeMaxRetries: 2,
  runtimeProxyEnabled: false,
  runtimeProxyRequireAuth: true,
  runtimeTimeoutMs: 30000,
  shutdownDrainMs: 5000,
  telegramApiBaseUrl: "https://api.telegram.org",
  telegramDeliverAuthBypass: false,
  telegramInitialBackoffMs: 1000,
  telegramMaxRetries: 3,
  telegramTimeoutMs: 15000,
  unmappedPolicy: "default",
  whatsappDeliverAuthBypass: false,
  whatsappTimeoutMs: 15000,
  whatsappMaxRetries: 3,
  whatsappInitialBackoffMs: 1000,
  slackDeliverAuthBypass: false,
  trustProxy: false,
};

/** Create mock caches for the WhatsApp webhook handler. */
function makeCaches() {
  const credentials = {
    get: async (key: string) => {
      if (key === "credential:whatsapp:app_secret") return "test-app-secret";
      if (key === "credential:whatsapp:webhook_verify_token")
        return "verify-token";
      if (key === "credential:whatsapp:phone_number_id") return "test-phone-id";
      if (key === "credential:whatsapp:access_token")
        return "test-access-token";
      return undefined;
    },
    invalidate: () => {},
  } as unknown as CredentialCache;
  return { credentials };
}

function buildPostReq(body: Record<string, unknown>): Request {
  return new Request("http://localhost:7830/webhooks/whatsapp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("whatsapp-webhook", () => {
  beforeEach(() => {
    handleInboundMock.mockClear();
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({ forwarded: true, rejected: false }),
    );
    resetConversationMock.mockClear();
    uploadAttachmentMock.mockClear();
    uploadAttachmentMock.mockImplementation(() =>
      Promise.resolve({ id: "att-uploaded-1" }),
    );
    downloadWhatsAppFileMock.mockClear();
    downloadWhatsAppFileMock.mockImplementation(() =>
      Promise.resolve({
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        data: "base64data",
      }),
    );
    sendWhatsAppReplyMock.mockClear();
    markWhatsAppMessageReadMock.mockClear();
    normalizeWhatsAppWebhookMock.mockClear();
    normalizeWhatsAppWebhookMock.mockImplementation(() => []);
    verifyWhatsAppWebhookSignatureMock.mockClear();
    verifyWhatsAppWebhookSignatureMock.mockImplementation(() => true);
  });

  it("validates GET verify-token handshake", async () => {
    const { handler } = createWhatsAppWebhookHandler(baseConfig, makeCaches());
    const req = new Request(
      "http://localhost:7830/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=12345",
      { method: "GET" },
    );

    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("12345");
  });

  it("rejects GET verify-token handshake when token mismatches", async () => {
    const { handler } = createWhatsAppWebhookHandler(baseConfig, makeCaches());
    const req = new Request(
      "http://localhost:7830/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345",
      { method: "GET" },
    );

    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  it("fails closed when whatsappAppSecret is not configured", async () => {
    // No caches provided — app secret lookup returns undefined
    const { handler } = createWhatsAppWebhookHandler(baseConfig);

    const res = await handler(
      buildPostReq({ object: "whatsapp_business_account", entry: [] }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Webhook signature validation not configured");
  });

  it("rejects POST when signature verification fails", async () => {
    verifyWhatsAppWebhookSignatureMock.mockImplementation(() => false);

    const { handler } = createWhatsAppWebhookHandler(baseConfig, makeCaches());
    const res = await handler(
      buildPostReq({ object: "whatsapp_business_account", entry: [] }),
    );

    expect(res.status).toBe(403);
    // Called twice: once with cached app_secret, then once more after force-refresh
    expect(verifyWhatsAppWebhookSignatureMock).toHaveBeenCalledTimes(2);
  });

  it("acknowledges non-message payloads without forwarding", async () => {
    const { handler } = createWhatsAppWebhookHandler(baseConfig, makeCaches());
    normalizeWhatsAppWebhookMock.mockImplementation(() => []);

    const res = await handler(
      buildPostReq({ object: "whatsapp_business_account", entry: [] }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(handleInboundMock).not.toHaveBeenCalled();
  });

  it("forwards normalized inbound WhatsApp messages to runtime with channel metadata", async () => {
    const { handler } = createWhatsAppWebhookHandler(baseConfig, makeCaches());

    normalizeWhatsAppWebhookMock.mockImplementation(() => [
      {
        whatsappMessageId: "wamid-1",
        event: {
          version: "v1",
          sourceChannel: "whatsapp",
          receivedAt: new Date().toISOString(),
          message: {
            content: "hello from whatsapp",
            conversationExternalId: "15551230000",
            externalMessageId: "wamid-1",
          },
          actor: {
            actorExternalId: "15551230000",
            displayName: "Alice",
          },
          source: {
            updateId: "wamid-1",
            messageId: "wamid-1",
            chatType: "private",
          },
          raw: {},
        },
      },
    ]);

    const res = await handler(
      buildPostReq({ object: "whatsapp_business_account", entry: [] }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);

    expect(handleInboundMock).toHaveBeenCalledTimes(1);
    const [_cfg, event, options] = handleInboundMock.mock
      .calls[0] as unknown as [
      GatewayConfig,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(event.sourceChannel).toBe("whatsapp");
    expect(options.replyCallbackUrl).toBe(
      "http://127.0.0.1:7830/deliver/whatsapp",
    );
    expect((options.transportMetadata as { hints: string[] }).hints).toContain(
      "whatsapp-formatting",
    );
    expect(markWhatsAppMessageReadMock).toHaveBeenCalledWith(
      baseConfig,
      "wamid-1",
      expect.objectContaining({ credentials: expect.anything() }),
    );
  });

  it("returns 500 when runtime forwarding fails for a normalized message", async () => {
    const { handler } = createWhatsAppWebhookHandler(baseConfig, makeCaches());
    normalizeWhatsAppWebhookMock.mockImplementation(() => [
      {
        whatsappMessageId: "wamid-fail",
        event: {
          version: "v1",
          sourceChannel: "whatsapp",
          receivedAt: new Date().toISOString(),
          message: {
            content: "hello",
            conversationExternalId: "15550000001",
            externalMessageId: "wamid-fail",
          },
          actor: {
            actorExternalId: "15550000001",
            displayName: "Bob",
          },
          source: {
            updateId: "wamid-fail",
            messageId: "wamid-fail",
            chatType: "private",
          },
          raw: {},
        },
      },
    ]);
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({ forwarded: false, rejected: false }),
    );

    const res = await handler(
      buildPostReq({ object: "whatsapp_business_account", entry: [] }),
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Internal error");
  });

  it("downloads and uploads media attachments, passing attachmentIds to handleInbound", async () => {
    const { handler } = createWhatsAppWebhookHandler(baseConfig, makeCaches());

    uploadAttachmentMock.mockImplementation(() =>
      Promise.resolve({ id: "att-img-1" }),
    );

    normalizeWhatsAppWebhookMock.mockImplementation(() => [
      {
        whatsappMessageId: "wamid-media-1",
        mediaType: "image",
        event: {
          version: "v1",
          sourceChannel: "whatsapp",
          receivedAt: new Date().toISOString(),
          message: {
            content: "check this out",
            conversationExternalId: "15551230000",
            externalMessageId: "wamid-media-1",
            attachments: [
              {
                type: "image",
                fileId: "media-id-123",
                mimeType: "image/jpeg",
                fileSize: 1024,
              },
            ],
          },
          actor: {
            actorExternalId: "15551230000",
            displayName: "Alice",
          },
          source: {
            updateId: "wamid-media-1",
            messageId: "wamid-media-1",
            chatType: "private",
          },
          raw: {},
        },
      },
    ]);

    const res = await handler(
      buildPostReq({ object: "whatsapp_business_account", entry: [] }),
    );

    expect(res.status).toBe(200);
    expect(downloadWhatsAppFileMock).toHaveBeenCalledTimes(1);
    expect(downloadWhatsAppFileMock).toHaveBeenCalledWith(
      baseConfig,
      "media-id-123",
      expect.objectContaining({ mimeType: "image/jpeg" }),
      expect.objectContaining({ credentials: expect.anything() }),
    );
    expect(uploadAttachmentMock).toHaveBeenCalledTimes(1);

    expect(handleInboundMock).toHaveBeenCalledTimes(1);
    const [, , options] = handleInboundMock.mock.calls[0] as unknown as [
      GatewayConfig,
      Record<string, unknown>,
      { attachmentIds?: string[] },
    ];
    expect(options.attachmentIds).toEqual(["att-img-1"]);
  });

  it("forwards media-only messages (no caption) when attachment upload succeeds", async () => {
    const { handler } = createWhatsAppWebhookHandler(baseConfig, makeCaches());

    uploadAttachmentMock.mockImplementation(() =>
      Promise.resolve({ id: "att-img-2" }),
    );

    normalizeWhatsAppWebhookMock.mockImplementation(() => [
      {
        whatsappMessageId: "wamid-media-only",
        mediaType: "image",
        event: {
          version: "v1",
          sourceChannel: "whatsapp",
          receivedAt: new Date().toISOString(),
          message: {
            content: "",
            conversationExternalId: "15551230000",
            externalMessageId: "wamid-media-only",
            attachments: [
              {
                type: "image",
                fileId: "media-id-456",
                mimeType: "image/png",
                fileSize: 2048,
              },
            ],
          },
          actor: {
            actorExternalId: "15551230000",
            displayName: "Alice",
          },
          source: {
            updateId: "wamid-media-only",
            messageId: "wamid-media-only",
            chatType: "private",
          },
          raw: {},
        },
      },
    ]);

    const res = await handler(
      buildPostReq({ object: "whatsapp_business_account", entry: [] }),
    );

    expect(res.status).toBe(200);
    expect(handleInboundMock).toHaveBeenCalledTimes(1);
    const [, , options] = handleInboundMock.mock.calls[0] as unknown as [
      GatewayConfig,
      Record<string, unknown>,
      { attachmentIds?: string[] },
    ];
    expect(options.attachmentIds).toEqual(["att-img-2"]);
  });

  it("skips validation errors for one attachment without dropping the message", async () => {
    const { handler } = createWhatsAppWebhookHandler(baseConfig, makeCaches());

    let callCount = 0;
    uploadAttachmentMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        throw new MockAttachmentValidationError("Unsupported MIME type");
      }
      return Promise.resolve({ id: "att-good" });
    });

    normalizeWhatsAppWebhookMock.mockImplementation(() => [
      {
        whatsappMessageId: "wamid-mixed",
        mediaType: "image",
        event: {
          version: "v1",
          sourceChannel: "whatsapp",
          receivedAt: new Date().toISOString(),
          message: {
            content: "two attachments",
            conversationExternalId: "15551230000",
            externalMessageId: "wamid-mixed",
            attachments: [
              {
                type: "image",
                fileId: "bad-media-id",
                mimeType: "image/tiff",
                fileSize: 1024,
              },
              {
                type: "document",
                fileId: "good-media-id",
                mimeType: "application/pdf",
                fileSize: 2048,
              },
            ],
          },
          actor: {
            actorExternalId: "15551230000",
            displayName: "Alice",
          },
          source: {
            updateId: "wamid-mixed",
            messageId: "wamid-mixed",
            chatType: "private",
          },
          raw: {},
        },
      },
    ]);

    const res = await handler(
      buildPostReq({ object: "whatsapp_business_account", entry: [] }),
    );

    expect(res.status).toBe(200);
    expect(handleInboundMock).toHaveBeenCalledTimes(1);
    const [, , options] = handleInboundMock.mock.calls[0] as unknown as [
      GatewayConfig,
      Record<string, unknown>,
      { attachmentIds?: string[] },
    ];
    expect(options.attachmentIds).toEqual(["att-good"]);
  });

  it("returns 500 on transient download failure so Meta retries", async () => {
    const { handler } = createWhatsAppWebhookHandler(baseConfig, makeCaches());

    downloadWhatsAppFileMock.mockImplementation(() => {
      throw new Error("Network timeout");
    });

    normalizeWhatsAppWebhookMock.mockImplementation(() => [
      {
        whatsappMessageId: "wamid-transient",
        mediaType: "image",
        event: {
          version: "v1",
          sourceChannel: "whatsapp",
          receivedAt: new Date().toISOString(),
          message: {
            content: "photo",
            conversationExternalId: "15551230000",
            externalMessageId: "wamid-transient",
            attachments: [
              {
                type: "image",
                fileId: "media-transient",
                mimeType: "image/jpeg",
                fileSize: 1024,
              },
            ],
          },
          actor: {
            actorExternalId: "15551230000",
            displayName: "Alice",
          },
          source: {
            updateId: "wamid-transient",
            messageId: "wamid-transient",
            chatType: "private",
          },
          raw: {},
        },
      },
    ]);

    const res = await handler(
      buildPostReq({ object: "whatsapp_business_account", entry: [] }),
    );

    expect(res.status).toBe(500);
    expect(handleInboundMock).not.toHaveBeenCalled();
  });

  it("skips non-retryable 4xx download errors and forwards message with empty attachments", async () => {
    const { handler, dedupCache } = createWhatsAppWebhookHandler(
      baseConfig,
      makeCaches(),
    );

    downloadWhatsAppFileMock.mockImplementation(() => {
      throw new MockWhatsAppNonRetryableError(
        "WhatsApp downloadMedia failed with status 404: Not Found",
      );
    });

    normalizeWhatsAppWebhookMock.mockImplementation(() => [
      {
        whatsappMessageId: "wamid-nonretryable",
        mediaType: "image",
        event: {
          version: "v1",
          sourceChannel: "whatsapp",
          receivedAt: new Date().toISOString(),
          message: {
            content: "check this photo",
            conversationExternalId: "15551230000",
            externalMessageId: "wamid-nonretryable",
            attachments: [
              {
                type: "image",
                fileId: "media-expired",
                mimeType: "image/jpeg",
                fileSize: 1024,
              },
            ],
          },
          actor: {
            actorExternalId: "15551230000",
            displayName: "Alice",
          },
          source: {
            updateId: "wamid-nonretryable",
            messageId: "wamid-nonretryable",
            chatType: "private",
          },
          raw: {},
        },
      },
    ]);

    const res = await handler(
      buildPostReq({ object: "whatsapp_business_account", entry: [] }),
    );

    expect(res.status).toBe(200);
    expect(handleInboundMock).toHaveBeenCalledTimes(1);
    const [, , options] = handleInboundMock.mock.calls[0] as unknown as [
      GatewayConfig,
      Record<string, unknown>,
      { attachmentIds?: string[] },
    ];
    expect(options.attachmentIds).toEqual([]);

    // Dedup cache should be marked (not unreserved)
    expect(dedupCache.reserve("wamid-nonretryable")).toBe(false);
  });

  it("deduplicates messages with the same WhatsApp message ID", async () => {
    const { handler } = createWhatsAppWebhookHandler(baseConfig, makeCaches());

    normalizeWhatsAppWebhookMock.mockImplementation(() => [
      {
        whatsappMessageId: "wamid-dedup-1",
        event: {
          version: "v1",
          sourceChannel: "whatsapp",
          receivedAt: new Date().toISOString(),
          message: {
            content: "first delivery",
            conversationExternalId: "15551230000",
            externalMessageId: "wamid-dedup-1",
          },
          actor: {
            actorExternalId: "15551230000",
            displayName: "Alice",
          },
          source: {
            updateId: "wamid-dedup-1",
            messageId: "wamid-dedup-1",
            chatType: "private",
          },
          raw: {},
        },
      },
    ]);

    // First delivery succeeds
    const res1 = await handler(
      buildPostReq({ object: "whatsapp_business_account", entry: [] }),
    );
    expect(res1.status).toBe(200);
    expect(handleInboundMock).toHaveBeenCalledTimes(1);

    // Second delivery of same message ID is silently ignored
    const res2 = await handler(
      buildPostReq({ object: "whatsapp_business_account", entry: [] }),
    );
    expect(res2.status).toBe(200);
    expect(handleInboundMock).toHaveBeenCalledTimes(1); // still 1
  });

  it("marks each message as read even for media-only messages", async () => {
    const { handler } = createWhatsAppWebhookHandler(baseConfig, makeCaches());

    uploadAttachmentMock.mockImplementation(() =>
      Promise.resolve({ id: "att-read-1" }),
    );

    normalizeWhatsAppWebhookMock.mockImplementation(() => [
      {
        whatsappMessageId: "wamid-read-media",
        mediaType: "image",
        event: {
          version: "v1",
          sourceChannel: "whatsapp",
          receivedAt: new Date().toISOString(),
          message: {
            content: "",
            conversationExternalId: "15551230000",
            externalMessageId: "wamid-read-media",
            attachments: [
              {
                type: "image",
                fileId: "media-read-1",
                mimeType: "image/jpeg",
                fileSize: 1024,
              },
            ],
          },
          actor: {
            actorExternalId: "15551230000",
            displayName: "Alice",
          },
          source: {
            updateId: "wamid-read-media",
            messageId: "wamid-read-media",
            chatType: "private",
          },
          raw: {},
        },
      },
    ]);

    const res = await handler(
      buildPostReq({ object: "whatsapp_business_account", entry: [] }),
    );

    expect(res.status).toBe(200);
    expect(markWhatsAppMessageReadMock).toHaveBeenCalledWith(
      baseConfig,
      "wamid-read-media",
      expect.objectContaining({ credentials: expect.anything() }),
    );
  });

  it("handles multiple attachments in a single message", async () => {
    const { handler } = createWhatsAppWebhookHandler(baseConfig, makeCaches());

    let uploadCount = 0;
    uploadAttachmentMock.mockImplementation(() => {
      uploadCount++;
      return Promise.resolve({ id: `att-multi-${uploadCount}` });
    });

    normalizeWhatsAppWebhookMock.mockImplementation(() => [
      {
        whatsappMessageId: "wamid-multi-attach",
        mediaType: "document",
        event: {
          version: "v1",
          sourceChannel: "whatsapp",
          receivedAt: new Date().toISOString(),
          message: {
            content: "here are some files",
            conversationExternalId: "15551230000",
            externalMessageId: "wamid-multi-attach",
            attachments: [
              {
                type: "image",
                fileId: "media-multi-1",
                mimeType: "image/jpeg",
                fileSize: 1024,
              },
              {
                type: "document",
                fileId: "media-multi-2",
                mimeType: "application/pdf",
                fileSize: 2048,
              },
            ],
          },
          actor: {
            actorExternalId: "15551230000",
            displayName: "Alice",
          },
          source: {
            updateId: "wamid-multi-attach",
            messageId: "wamid-multi-attach",
            chatType: "private",
          },
          raw: {},
        },
      },
    ]);

    const res = await handler(
      buildPostReq({ object: "whatsapp_business_account", entry: [] }),
    );

    expect(res.status).toBe(200);
    expect(downloadWhatsAppFileMock).toHaveBeenCalledTimes(2);
    expect(uploadAttachmentMock).toHaveBeenCalledTimes(2);

    const [, , options] = handleInboundMock.mock.calls[0] as unknown as [
      GatewayConfig,
      Record<string, unknown>,
      { attachmentIds?: string[] },
    ];
    expect(options.attachmentIds).toEqual(["att-multi-1", "att-multi-2"]);
  });

  it("unreserves dedup cache on transient failure so retries can succeed", async () => {
    const { handler, dedupCache } = createWhatsAppWebhookHandler(
      baseConfig,
      makeCaches(),
    );

    downloadWhatsAppFileMock.mockImplementation(() => {
      throw new Error("Transient network error");
    });

    normalizeWhatsAppWebhookMock.mockImplementation(() => [
      {
        whatsappMessageId: "wamid-retry-ok",
        mediaType: "image",
        event: {
          version: "v1",
          sourceChannel: "whatsapp",
          receivedAt: new Date().toISOString(),
          message: {
            content: "photo",
            conversationExternalId: "15551230000",
            externalMessageId: "wamid-retry-ok",
            attachments: [
              {
                type: "image",
                fileId: "media-retry",
                mimeType: "image/jpeg",
                fileSize: 1024,
              },
            ],
          },
          actor: {
            actorExternalId: "15551230000",
            displayName: "Alice",
          },
          source: {
            updateId: "wamid-retry-ok",
            messageId: "wamid-retry-ok",
            chatType: "private",
          },
          raw: {},
        },
      },
    ]);

    // First attempt fails with 500
    const res1 = await handler(
      buildPostReq({ object: "whatsapp_business_account", entry: [] }),
    );
    expect(res1.status).toBe(500);

    // The dedup cache should have unreserved the ID so a retry can proceed
    expect(dedupCache.reserve("wamid-retry-ok")).toBe(true);
  });

  it("skips oversized attachments without failing the message", async () => {
    const { handler } = createWhatsAppWebhookHandler(baseConfig, makeCaches());

    normalizeWhatsAppWebhookMock.mockImplementation(() => [
      {
        whatsappMessageId: "wamid-oversize",
        mediaType: "video",
        event: {
          version: "v1",
          sourceChannel: "whatsapp",
          receivedAt: new Date().toISOString(),
          message: {
            content: "big video",
            conversationExternalId: "15551230000",
            externalMessageId: "wamid-oversize",
            attachments: [
              {
                type: "video",
                fileId: "media-big",
                mimeType: "video/mp4",
                fileSize: 100 * 1024 * 1024, // 100 MB — over limit
              },
            ],
          },
          actor: {
            actorExternalId: "15551230000",
            displayName: "Alice",
          },
          source: {
            updateId: "wamid-oversize",
            messageId: "wamid-oversize",
            chatType: "private",
          },
          raw: {},
        },
      },
    ]);

    const res = await handler(
      buildPostReq({ object: "whatsapp_business_account", entry: [] }),
    );

    expect(res.status).toBe(200);
    expect(downloadWhatsAppFileMock).not.toHaveBeenCalled();
    expect(handleInboundMock).toHaveBeenCalledTimes(1);
    const [, , options] = handleInboundMock.mock.calls[0] as unknown as [
      GatewayConfig,
      Record<string, unknown>,
      { attachmentIds?: string[] },
    ];
    // No attachmentIds since the only attachment was oversized
    expect(options.attachmentIds).toEqual([]);
  });
});
