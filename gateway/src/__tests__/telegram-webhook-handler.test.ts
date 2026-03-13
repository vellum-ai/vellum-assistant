import { describe, test, expect, mock, afterEach, beforeEach } from "bun:test";
import type { GatewayConfig } from "../config.js";
import type { CredentialCache } from "../credential-cache.js";
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

const { createTelegramWebhookHandler } =
  await import("../http/routes/telegram-webhook.js");

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
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
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: 20971520,
    maxAttachmentConcurrency: 3,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    trustProxy: false,
    ...overrides,
  };
  return merged;
}

function makeTelegramPayload(text: string, updateId = 1001) {
  return {
    update_id: updateId,
    message: {
      message_id: 42,
      text,
      chat: { id: 12345, type: "private" },
      from: {
        id: 67890,
        is_bot: false,
        username: "testuser",
        first_name: "Test",
      },
    },
  };
}

function makeWebhookRequest(
  payload: unknown,
  secret = "test-webhook-secret",
): Request {
  return new Request("http://localhost:7830/webhooks/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: JSON.stringify(payload),
  });
}

/** Create a mock CredentialCache that returns the webhook secret and bot token. */
function makeCaches(webhookSecret: string | undefined = "test-webhook-secret") {
  const credentials = {
    get: async (key: string) => {
      if (key === credentialKey("telegram", "webhook_secret"))
        return webhookSecret;
      if (key === credentialKey("telegram", "bot_token"))
        return "test-bot-token";
      return undefined;
    },
    invalidate: () => {},
  } as unknown as CredentialCache;
  return { credentials };
}

let fetchCalls: {
  url: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
}[];

beforeEach(() => {
  fetchCalls = [];
});

afterEach(() => {
  fetchMock = mock(async () => new Response());
});

/** Extract headers from a fetch call into a plain object. */
function extractHeaders(
  input: string | URL | Request,
  init?: RequestInit,
): Record<string, string> {
  const result: Record<string, string> = {};
  let headers: HeadersInit | undefined;
  if (init?.headers) {
    headers = init.headers;
  } else if (typeof input === "object" && "headers" in input) {
    headers = (input as Request).headers;
  }
  if (headers instanceof Headers) {
    headers.forEach((v, k) => {
      result[k] = v;
    });
  } else if (
    headers &&
    typeof headers === "object" &&
    !Array.isArray(headers)
  ) {
    for (const [k, v] of Object.entries(headers)) {
      result[k.toLowerCase()] = v;
    }
  }
  return result;
}

/**
 * Install a mock fetch that records calls and returns a 200 JSON response.
 * Runtime forward calls get an eventId response; Telegram API calls get { ok: true }.
 */
function installFetchMock() {
  fetchMock = mock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method =
        init?.method ??
        (typeof input === "object" && "method" in input ? input.method : "GET");
      let body: unknown;
      try {
        if (init?.body) {
          body = JSON.parse(String(init.body));
        } else if (typeof input === "object" && "json" in input) {
          body = await (input as Request).clone().json();
        }
      } catch {
        /* not JSON */
      }
      const headers = extractHeaders(input, init);
      fetchCalls.push({ url, method, body, headers });

      // Runtime inbound endpoint
      if (url.includes("/v1/channels/inbound")) {
        return new Response(
          JSON.stringify({ eventId: "evt-1", duplicate: false }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      // Runtime reset conversation endpoint
      if (url.includes("/channels/conversation") && method === "DELETE") {
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // Telegram API calls (sendMessage, etc.)
      if (url.includes("api.telegram.org")) {
        return new Response(JSON.stringify({ ok: true, result: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  );
}

describe("telegram webhook handler: gatewayInternalBaseUrl", () => {
  test("uses configured gatewayInternalBaseUrl in replyCallbackUrl", async () => {
    const config = makeConfig({
      gatewayInternalBaseUrl: "http://gateway.internal:9000",
      routingEntries: [
        { type: "conversation_id", key: "12345", assistantId: "assistant-a" },
      ],
    });
    installFetchMock();
    const { handler } = createTelegramWebhookHandler(config, makeCaches());

    const payload = makeTelegramPayload("hello");
    const req = makeWebhookRequest(payload);
    const res = await handler(req);

    expect(res.status).toBe(200);

    // Find the runtime forward call and verify the replyCallbackUrl
    const runtimeCall = fetchCalls.find((c) => c.url.includes("/inbound"));
    expect(runtimeCall).toBeDefined();
    expect((runtimeCall!.body as any).replyCallbackUrl).toBe(
      "http://gateway.internal:9000/deliver/telegram",
    );
  });

  test("falls back to localhost URL when gatewayInternalBaseUrl uses default", async () => {
    const config = makeConfig({
      gatewayInternalBaseUrl: "http://127.0.0.1:7830",
      routingEntries: [
        { type: "conversation_id", key: "12345", assistantId: "assistant-a" },
      ],
    });
    installFetchMock();
    const { handler } = createTelegramWebhookHandler(config, makeCaches());

    const payload = makeTelegramPayload("hello", 2001);
    const req = makeWebhookRequest(payload);
    const res = await handler(req);

    expect(res.status).toBe(200);

    const runtimeCall = fetchCalls.find((c) => c.url.includes("/inbound"));
    expect(runtimeCall).toBeDefined();
    expect((runtimeCall!.body as any).replyCallbackUrl).toBe(
      "http://127.0.0.1:7830/deliver/telegram",
    );
  });
});

describe("telegram webhook handler: /new rejection", () => {
  test("/start with payload forwards command intent metadata, does not reset conversation, and suppresses ACK", async () => {
    const config = makeConfig({
      routingEntries: [
        { type: "conversation_id", key: "12345", assistantId: "assistant-a" },
      ],
    });
    installFetchMock();
    const { handler } = createTelegramWebhookHandler(config, makeCaches());

    const payload = makeTelegramPayload("/start deep-link-token", 2501);
    const req = makeWebhookRequest(payload);
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const runtimeCall = fetchCalls.find((c) => c.url.includes("/inbound"));
    expect(runtimeCall).toBeDefined();
    expect((runtimeCall!.body as any).sourceMetadata.commandIntent).toEqual({
      type: "start",
      payload: "deep-link-token",
    });

    const resetCall = fetchCalls.find((c) =>
      c.url.includes("/channels/conversation"),
    );
    expect(resetCall).toBeUndefined();

    // ACK is suppressed when /start has a payload
    const sendMessageCall = fetchCalls.find((c) =>
      c.url.includes("/sendMessage"),
    );
    expect(sendMessageCall).toBeUndefined();
  });

  test("/start with routing rejection sends setup notice and does not forward", async () => {
    const config = makeConfig({ unmappedPolicy: "reject" });
    installFetchMock();
    const { handler } = createTelegramWebhookHandler(config, makeCaches());

    const payload = makeTelegramPayload("/start", 2502);
    (payload.message as any).chat.id = 54321;
    const req = makeWebhookRequest(payload);
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const runtimeCall = fetchCalls.find((c) => c.url.includes("/inbound"));
    expect(runtimeCall).toBeUndefined();

    const sendMessageCall = fetchCalls.find((c) =>
      c.url.includes("/sendMessage"),
    );
    expect(sendMessageCall).toBeDefined();
    expect((sendMessageCall!.body as any).text).toContain("not fully set up");
  });

  test("sends rejection notice when /new command routing is rejected", async () => {
    // No routing entries and unmappedPolicy is "reject" — routing will fail
    const config = makeConfig({ unmappedPolicy: "reject" });
    installFetchMock();
    const { handler } = createTelegramWebhookHandler(config, makeCaches());

    const payload = makeTelegramPayload("/new", 3001);
    const req = makeWebhookRequest(payload);
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify a Telegram sendMessage call was made with the rejection notice
    const telegramCalls = fetchCalls.filter((c) =>
      c.url.includes("api.telegram.org"),
    );
    expect(telegramCalls.length).toBeGreaterThanOrEqual(1);

    const sendCall = telegramCalls.find((c) => c.url.includes("/sendMessage"));
    expect(sendCall).toBeDefined();
    expect((sendCall!.body as any).text).toContain("could not be routed");
  });

  test("/new succeeds and sends confirmation when routing matches", async () => {
    const config = makeConfig({
      routingEntries: [
        { type: "conversation_id", key: "12345", assistantId: "assistant-a" },
      ],
    });
    installFetchMock();
    const { handler } = createTelegramWebhookHandler(config, makeCaches());

    const payload = makeTelegramPayload("/new", 4001);
    const req = makeWebhookRequest(payload);
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify the reset conversation call was made
    const resetCall = fetchCalls.find((c) =>
      c.url.includes("/channels/conversation"),
    );
    expect(resetCall).toBeDefined();
    expect(resetCall!.method).toBe("DELETE");

    // Verify the confirmation message was sent
    const telegramCalls = fetchCalls.filter((c) =>
      c.url.includes("api.telegram.org"),
    );
    expect(telegramCalls.length).toBeGreaterThanOrEqual(1);
    const confirmCall = telegramCalls.find((c) => {
      return (
        c.url.includes("/sendMessage") &&
        (c.body as any)?.text?.includes("new conversation")
      );
    });
    expect(confirmCall).toBeDefined();
  });

  test("/new rejection does not call resetConversation", async () => {
    const config = makeConfig({ unmappedPolicy: "reject" });
    installFetchMock();
    const { handler } = createTelegramWebhookHandler(config, makeCaches());

    const payload = makeTelegramPayload("/new", 5001);
    const req = makeWebhookRequest(payload);
    await handler(req);

    // Verify no reset conversation call was made
    const resetCall = fetchCalls.find((c) =>
      c.url.includes("/channels/conversation"),
    );
    expect(resetCall).toBeUndefined();
  });
});

describe("telegram webhook handler: in-flight dedup", () => {
  test("second request with same update_id returns 503 while first is still processing", async () => {
    // Simulate a slow runtime: the first request hangs until we resolve
    let resolveFirst!: () => void;
    const firstBlocks = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const config = makeConfig({
      routingEntries: [
        { type: "conversation_id", key: "12345", assistantId: "assistant-a" },
      ],
    });

    // Install a fetch mock where the runtime inbound call blocks on the first
    // invocation and responds immediately on subsequent ones.
    let inboundCallCount = 0;
    fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const method =
          init?.method ??
          (typeof input === "object" && "method" in input
            ? input.method
            : "GET");
        let body: unknown;
        try {
          if (init?.body) body = JSON.parse(String(init.body));
          else if (typeof input === "object" && "json" in input)
            body = await (input as Request).clone().json();
        } catch {
          /* not JSON */
        }
        fetchCalls.push({ url, method, body });

        if (url.includes("/v1/channels/inbound")) {
          inboundCallCount++;
          if (inboundCallCount === 1) {
            await firstBlocks; // hang until test releases
          }
          return new Response(
            JSON.stringify({ eventId: "evt-1", duplicate: false }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (url.includes("api.telegram.org")) {
          return new Response(JSON.stringify({ ok: true, result: {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    );

    const { handler } = createTelegramWebhookHandler(config, makeCaches());
    const payload = makeTelegramPayload("hello", 9001);

    // Fire first request (will block on runtime call)
    const first = handler(makeWebhookRequest(payload));

    // Fire second request with same update_id while first is in-flight
    const second = await handler(makeWebhookRequest(payload));
    expect(second.status).toBe(503);
    expect(second.headers.get("Retry-After")).toBe("1");

    // Let the first request finish
    resolveFirst();
    const firstRes = await first;
    expect(firstRes.status).toBe(200);

    // Third request after processing completed — should get cached 200
    const third = await handler(makeWebhookRequest(payload));
    expect(third.status).toBe(200);
    const thirdBody = await third.json();
    expect(thirdBody.ok).toBe(true);
  });

  test("failed processing unreserves, allowing retry to be processed normally", async () => {
    const config = makeConfig({
      routingEntries: [
        { type: "conversation_id", key: "12345", assistantId: "assistant-a" },
      ],
      runtimeMaxRetries: 0,
    });

    let callCount = 0;
    fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const method =
          init?.method ??
          (typeof input === "object" && "method" in input
            ? input.method
            : "GET");
        let body: unknown;
        try {
          if (init?.body) body = JSON.parse(String(init.body));
          else if (typeof input === "object" && "json" in input)
            body = await (input as Request).clone().json();
        } catch {
          /* not JSON */
        }
        fetchCalls.push({ url, method, body });

        if (url.includes("/v1/channels/inbound")) {
          callCount++;
          if (callCount === 1) {
            // First call fails
            return new Response("Internal error", { status: 500 });
          }
          // Subsequent calls succeed
          return new Response(
            JSON.stringify({ eventId: "evt-2", duplicate: false }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (url.includes("api.telegram.org")) {
          return new Response(JSON.stringify({ ok: true, result: {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    );

    const { handler } = createTelegramWebhookHandler(config, makeCaches());
    const payload = makeTelegramPayload("hello", 9002);

    // First attempt fails — should return 500 and unreserve
    const first = await handler(makeWebhookRequest(payload));
    expect(first.status).toBe(500);

    // Retry with same update_id — should be processed (not permanently deduped)
    const retry = await handler(makeWebhookRequest(payload));
    expect(retry.status).toBe(200);
    const retryBody = await retry.json();
    expect(retryBody.ok).toBe(true);
  });

  test("after successful processing, duplicates return cached success", async () => {
    const config = makeConfig({
      routingEntries: [
        { type: "conversation_id", key: "12345", assistantId: "assistant-a" },
      ],
    });
    installFetchMock();
    const { handler } = createTelegramWebhookHandler(config, makeCaches());
    const payload = makeTelegramPayload("hello", 9003);

    // Process successfully
    const first = await handler(makeWebhookRequest(payload));
    expect(first.status).toBe(200);

    // Duplicate returns cached response without hitting the runtime again
    const beforeCount = fetchCalls.length;
    const dup = await handler(makeWebhookRequest(payload));
    expect(dup.status).toBe(200);
    const dupBody = await dup.json();
    expect(dupBody.ok).toBe(true);
    // No new fetch calls should have been made (response came from cache)
    expect(fetchCalls.length).toBe(beforeCount);
  });
});

function makeCallbackQueryPayload(data: string, updateId = 7001) {
  return {
    update_id: updateId,
    callback_query: {
      id: "cbq-test-id",
      from: {
        id: 67890,
        is_bot: false,
        username: "testuser",
        first_name: "Test",
      },
      message: {
        message_id: 42,
        text: "Choose an action",
        chat: { id: 12345, type: "private" },
      },
      data,
    },
  };
}

describe("telegram webhook handler: callback_query forwarding", () => {
  test("forwards callback_query data to the runtime with callback metadata", async () => {
    const config = makeConfig({
      routingEntries: [
        { type: "conversation_id", key: "12345", assistantId: "assistant-a" },
      ],
    });
    installFetchMock();
    const { handler } = createTelegramWebhookHandler(config, makeCaches());

    const payload = makeCallbackQueryPayload("apr:run-abc:approve", 7001);
    const req = makeWebhookRequest(payload);
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify the runtime forward call includes callback metadata
    const runtimeCall = fetchCalls.find((c) => c.url.includes("/inbound"));
    expect(runtimeCall).toBeDefined();
    const runtimeBody = runtimeCall!.body as any;
    expect(runtimeBody.callbackQueryId).toBe("cbq-test-id");
    expect(runtimeBody.callbackData).toBe("apr:run-abc:approve");
    expect(runtimeBody.content).toBe("apr:run-abc:approve");
  });

  test("acknowledges the callback query via answerCallbackQuery after forwarding", async () => {
    const config = makeConfig({
      routingEntries: [
        { type: "conversation_id", key: "12345", assistantId: "assistant-a" },
      ],
    });
    installFetchMock();
    const { handler } = createTelegramWebhookHandler(config, makeCaches());

    const payload = makeCallbackQueryPayload("apr:run-xyz:reject", 7002);
    const req = makeWebhookRequest(payload);
    await handler(req);

    // Allow the fire-and-forget answerCallbackQuery call to complete
    await new Promise((r) => setTimeout(r, 50));

    // Verify answerCallbackQuery was called
    const ackCall = fetchCalls.find((c) =>
      c.url.includes("/answerCallbackQuery"),
    );
    expect(ackCall).toBeDefined();
    expect((ackCall!.body as any).callback_query_id).toBe("cbq-test-id");
  });

  test("does not call answerCallbackQuery for regular text messages", async () => {
    const config = makeConfig({
      routingEntries: [
        { type: "conversation_id", key: "12345", assistantId: "assistant-a" },
      ],
    });
    installFetchMock();
    const { handler } = createTelegramWebhookHandler(config, makeCaches());

    const payload = makeTelegramPayload("hello", 7003);
    const req = makeWebhookRequest(payload);
    await handler(req);

    // Allow any fire-and-forget calls to complete
    await new Promise((r) => setTimeout(r, 50));

    // Verify no answerCallbackQuery call was made
    const ackCall = fetchCalls.find((c) =>
      c.url.includes("/answerCallbackQuery"),
    );
    expect(ackCall).toBeUndefined();
  });

  test("regular text messages do not include callback metadata in runtime payload", async () => {
    const config = makeConfig({
      routingEntries: [
        { type: "conversation_id", key: "12345", assistantId: "assistant-a" },
      ],
    });
    installFetchMock();
    const { handler } = createTelegramWebhookHandler(config, makeCaches());

    const payload = makeTelegramPayload("hello", 7004);
    const req = makeWebhookRequest(payload);
    await handler(req);

    const runtimeCall = fetchCalls.find((c) => c.url.includes("/inbound"));
    expect(runtimeCall).toBeDefined();
    const runtimeBody = runtimeCall!.body as any;
    expect(runtimeBody.callbackQueryId).toBeUndefined();
    expect(runtimeBody.callbackData).toBeUndefined();
  });
});
