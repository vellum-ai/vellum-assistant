import { describe, test, expect, mock, afterEach } from "bun:test";
import type { GatewayConfig } from "../config.js";
import type { CredentialCache } from "../credential-cache.js";
import { initSigningKey, mintToken } from "../auth/token-service.js";
import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";

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

const { createTelegramDeliverHandler } =
  await import("../http/routes/telegram-deliver.js");

/** Mint a valid daemon JWT for deliver auth. */
function mintDeliverToken(): string {
  return mintToken({
    aud: "vellum-daemon",
    sub: "svc:gateway:self",
    scope_profile: "gateway_service_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 300,
  });
}

const TOKEN = mintDeliverToken();

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    telegramApiBaseUrl: "https://api.telegram.org",
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: false,
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
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    whatsappDeliverAuthBypass: false,
    whatsappTimeoutMs: 15000,
    whatsappMaxRetries: 3,
    whatsappInitialBackoffMs: 1000,
    slackDeliverAuthBypass: false,
    trustProxy: false,
    ...overrides,
  };
  return merged;
}

afterEach(() => {
  fetchMock = mock(async () => new Response());
});

/** Create a mock CredentialCache that returns the bot token. */
function makeCaches() {
  const credentials = {
    get: async (key: string) => {
      if (key === "credential:telegram:bot_token") return "test-bot-token";
      return undefined;
    },
    invalidate: () => {},
  } as unknown as CredentialCache;
  return { credentials };
}

function mockTelegramApi() {
  fetchMock = mock(async () => {
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("/deliver/telegram attachment delivery without assistantId", () => {
  test("delivers attachments without assistantId using assistant-less download path", async () => {
    const calls: string[] = [];
    fetchMock = mock(async (input: string | URL | Request) => {
      const urlStr =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push(urlStr);
      // Runtime attachment download (assistant-less path)
      if (urlStr.includes("/v1/attachments/att-1")) {
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
      // Telegram API calls
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createTelegramDeliverHandler(
      makeConfig({ telegramDeliverAuthBypass: true }),
      makeCaches(),
    );
    const req = new Request("http://localhost:7830/deliver/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chatId: "123",
        attachments: [
          {
            id: "att-1",
            filename: "photo.png",
            mimeType: "image/png",
            sizeBytes: 100,
            kind: "generated_image",
          },
        ],
      }),
    });
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Should have downloaded via /v1/attachments/att-1 (no assistantId in URL)
    const downloadCall = calls.find((u) => u.includes("/attachments/att-1"));
    expect(downloadCall).toBeDefined();
    expect(downloadCall).not.toContain("/assistants/");

    // Should have sent the photo via Telegram
    const telegramCall = calls.find((u) => u.includes("sendPhoto"));
    expect(telegramCall).toBeDefined();
  });

  test("delivers attachments with assistantId using flat download path", async () => {
    const calls: string[] = [];
    fetchMock = mock(async (input: string | URL | Request) => {
      const urlStr =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push(urlStr);
      // Runtime attachment download (flat path)
      if (urlStr.includes("/attachments/att-2")) {
        return new Response(
          JSON.stringify({
            id: "att-2",
            filename: "doc.pdf",
            mimeType: "application/pdf",
            sizeBytes: 200,
            kind: "filesystem",
            data: "JVBER",
          }),
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createTelegramDeliverHandler(
      makeConfig({ telegramDeliverAuthBypass: true }),
      makeCaches(),
    );
    const req = new Request("http://localhost:7830/deliver/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chatId: "456",
        assistantId: "my-assistant",
        attachments: [
          {
            id: "att-2",
            filename: "doc.pdf",
            mimeType: "application/pdf",
            sizeBytes: 200,
            kind: "filesystem",
          },
        ],
      }),
    });
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Should have downloaded via flat /v1/attachments/att-2 (assistantId is ignored)
    const downloadCall = calls.find((u) => u.includes("/attachments/att-2"));
    expect(downloadCall).toBeDefined();
    expect(downloadCall).not.toContain("/assistants/");
  });
});

describe("/deliver/telegram ID-only attachment validation", () => {
  test("accepts ID-only attachments (no filename, mimeType, sizeBytes)", async () => {
    const calls: string[] = [];
    fetchMock = mock(async (input: string | URL | Request) => {
      const urlStr =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push(urlStr);
      if (urlStr.includes("/v1/attachments/att-id-only")) {
        return new Response(
          JSON.stringify({
            id: "att-id-only",
            filename: "hydrated.png",
            mimeType: "image/png",
            sizeBytes: 80,
            kind: "generated_image",
            data: "iVBORw0KGgo=",
          }),
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createTelegramDeliverHandler(
      makeConfig({ telegramDeliverAuthBypass: true }),
      makeCaches(),
    );
    const req = new Request("http://localhost:7830/deliver/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chatId: "789",
        attachments: [{ id: "att-id-only" }],
      }),
    });
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Should have downloaded the attachment and sent it to Telegram
    const downloadCall = calls.find((u) =>
      u.includes("/attachments/att-id-only"),
    );
    expect(downloadCall).toBeDefined();
    const telegramCall = calls.find((u) => u.includes("sendPhoto"));
    expect(telegramCall).toBeDefined();
  });

  test("rejects attachment missing id with 400", async () => {
    const handler = createTelegramDeliverHandler(
      makeConfig({ telegramDeliverAuthBypass: true }),
      makeCaches(),
    );
    const req = new Request("http://localhost:7830/deliver/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chatId: "789",
        attachments: [{ filename: "no-id.png", mimeType: "image/png" }],
      }),
    });
    const res = await handler(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("each attachment must have an id");
  });

  test("full-metadata attachments still accepted (backward compatibility)", async () => {
    const calls: string[] = [];
    fetchMock = mock(async (input: string | URL | Request) => {
      const urlStr =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push(urlStr);
      if (urlStr.includes("/v1/attachments/att-compat")) {
        return new Response(
          JSON.stringify({
            id: "att-compat",
            filename: "doc.pdf",
            mimeType: "application/pdf",
            sizeBytes: 150,
            kind: "filesystem",
            data: "JVBER",
          }),
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createTelegramDeliverHandler(
      makeConfig({ telegramDeliverAuthBypass: true }),
      makeCaches(),
    );
    const req = new Request("http://localhost:7830/deliver/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chatId: "789",
        attachments: [
          {
            id: "att-compat",
            filename: "doc.pdf",
            mimeType: "application/pdf",
            sizeBytes: 150,
            kind: "filesystem",
          },
        ],
      }),
    });
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

describe("/deliver/telegram bearer auth enforcement", () => {
  test("rejects request without Authorization header with 401", async () => {
    const handler = createTelegramDeliverHandler(makeConfig(), makeCaches());
    const req = new Request("http://localhost:7830/deliver/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: "123", text: "hello" }),
    });
    const res = await handler(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("rejects request with wrong bearer token with 401", async () => {
    const handler = createTelegramDeliverHandler(makeConfig(), makeCaches());
    const req = new Request("http://localhost:7830/deliver/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({ chatId: "123", text: "hello" }),
    });
    const res = await handler(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("rejects request with empty bearer token with 401", async () => {
    const handler = createTelegramDeliverHandler(makeConfig(), makeCaches());
    const req = new Request("http://localhost:7830/deliver/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer ",
      },
      body: JSON.stringify({ chatId: "123", text: "hello" }),
    });
    const res = await handler(req);

    expect(res.status).toBe(401);
  });

  test("accepts request with correct bearer token", async () => {
    mockTelegramApi();
    const handler = createTelegramDeliverHandler(makeConfig(), makeCaches());
    const req = new Request("http://localhost:7830/deliver/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ chatId: "123", text: "hello" }),
    });
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("allows unauthenticated access when bypass flag is set and no token configured", async () => {
    mockTelegramApi();
    const handler = createTelegramDeliverHandler(
      makeConfig({ telegramDeliverAuthBypass: true }),
      makeCaches(),
    );
    const req = new Request("http://localhost:7830/deliver/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: "123", text: "hello" }),
    });
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("still rejects non-POST methods before auth check", async () => {
    const handler = createTelegramDeliverHandler(makeConfig(), makeCaches());
    const req = new Request("http://localhost:7830/deliver/telegram", {
      method: "GET",
    });
    const res = await handler(req);

    expect(res.status).toBe(405);
  });

  test("still validates request body after successful auth", async () => {
    const handler = createTelegramDeliverHandler(makeConfig(), makeCaches());
    const req = new Request("http://localhost:7830/deliver/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({}),
    });
    const res = await handler(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("chatId is required");
  });
});
