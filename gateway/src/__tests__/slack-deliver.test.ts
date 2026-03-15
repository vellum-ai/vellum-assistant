import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import type { GatewayConfig } from "../config.js";
import type { ConfigFileCache } from "../config-file-cache.js";
import type { CredentialCache } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";

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

mock.module("../auth/token-exchange.js", () => ({
  mintIngressToken: () => "mock-ingress-token",
  mintServiceToken: () => "mock-service-token",
  mintExchangeToken: () => "mock-exchange-token",
  mintBrowserRelayToken: () => "mock-browser-relay-token",
  validateEdgeToken: () => ({ ok: true }),
}));

const { createSlackDeliverHandler } =
  await import("../http/routes/slack-deliver.js");

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    defaultAssistantId: undefined,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: 20971520,
    maxAttachmentConcurrency: 3,
    maxWebhookPayloadBytes: 1048576,
    port: 7830,
    routingEntries: [],
    runtimeInitialBackoffMs: 500,
    runtimeMaxRetries: 2,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: false,
    runtimeTimeoutMs: 30000,
    shutdownDrainMs: 5000,
    unmappedPolicy: "reject",
    trustProxy: false,
    ...overrides,
  };
  return merged;
}

function makeConfigFile(
  overrides: Record<string, Record<string, string | number | boolean>> = {},
): ConfigFileCache {
  const data: Record<string, Record<string, string | number | boolean>> = {
    slack: { deliverAuthBypass: true },
    ...overrides,
  };
  return {
    getString: (section: string, key: string) =>
      data[section]?.[key] as string | undefined,
    getNumber: (section: string, key: string) =>
      data[section]?.[key] as number | undefined,
    getBoolean: (section: string, key: string) =>
      data[section]?.[key] as boolean | undefined,
    getRecord: () => undefined,
    refreshNow: () => {},
    invalidate: () => {},
  } as unknown as ConfigFileCache;
}

/** Create a mock CredentialCache that returns the given bot token. */
function makeCaches(...args: [] | [string | undefined]) {
  const botToken = args.length === 0 ? "xoxb-test-bot-token" : args[0];
  const credentials = {
    get: async (key: string) => {
      if (key === credentialKey("slack_channel", "bot_token")) return botToken;
      return undefined;
    },
    invalidate: () => {},
  } as unknown as CredentialCache;
  return { credentials, configFile: makeConfigFile() };
}

function makeRequest(
  body: unknown,
  headers?: Record<string, string>,
  queryString = "",
): Request {
  return new Request(`http://localhost:7830/deliver/slack${queryString}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const savedAppVersion = process.env.APP_VERSION;
// Default to dev mode so the bypass configFile takes effect
process.env.APP_VERSION = "0.0.0-dev";

let fetchCalls: {
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
  rawBody?: string;
}[];

beforeEach(() => {
  fetchCalls = [];
  process.env.APP_VERSION = "0.0.0-dev";
  fetchMock = mock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      let body: unknown;
      let rawBody: string | undefined;
      try {
        if (init?.body && typeof init.body === "string") {
          rawBody = init.body;
          body = JSON.parse(init.body);
        }
      } catch {
        /* not JSON */
      }
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = init.headers;
        if (h && typeof h === "object" && !Array.isArray(h)) {
          for (const [k, v] of Object.entries(h)) {
            headers[k.toLowerCase()] = v;
          }
        }
      }
      fetchCalls.push({ url, body, headers, rawBody });

      // Runtime attachment download endpoint
      if (url.includes("/v1/attachments/")) {
        const id = url.split("/v1/attachments/")[1];
        if (id === "att-fail") {
          return new Response('{"error":"not found"}', { status: 404 });
        }
        const payloads: Record<string, unknown> = {
          "att-img": {
            id: "att-img",
            filename: "photo.png",
            mimeType: "image/png",
            sizeBytes: 100,
            kind: "generated_image",
            data: "iVBORw0KGgo=",
          },
          "att-pdf": {
            id: "att-pdf",
            filename: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 200,
            kind: "filesystem",
            data: "JVBER",
          },
          "att-big": {
            id: "att-big",
            filename: "huge.zip",
            mimeType: "application/zip",
            sizeBytes: 999999999,
            kind: "filesystem",
            data: "AQID",
          },
          "att-ok": {
            id: "att-ok",
            filename: "good.png",
            mimeType: "image/png",
            sizeBytes: 50,
            kind: "generated_image",
            data: "iVBORw0KGgo=",
          },
        };
        const payload = payloads[id ?? ""];
        if (payload) {
          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response('{"error":"not found"}', { status: 404 });
      }

      // Slack API responses
      if (
        url.includes("slack.com/api/chat.postMessage") ||
        url.includes("slack.com/api/chat.postEphemeral")
      ) {
        return new Response(
          JSON.stringify({ ok: true, ts: "1700000000.000100" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.includes("slack.com/api/chat.update")) {
        return new Response(
          JSON.stringify({ ok: true, ts: "1700000000.000050" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      // Slack file upload URL (step 2 of files.uploadV2 flow)
      if (url.includes("files.slack.com/upload/")) {
        return new Response("OK", { status: 200 });
      }

      // Slack API responses (generic fallback for file upload APIs)
      if (url.includes("slack.com/api/")) {
        return new Response(
          JSON.stringify({
            ok: true,
            upload_url: "https://files.slack.com/upload/v1/abc",
            file_id: "F123",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("Not found", { status: 404 });
    },
  );
});

afterEach(() => {
  if (savedAppVersion === undefined) {
    delete process.env.APP_VERSION;
  } else {
    process.env.APP_VERSION = savedAppVersion;
  }
});

describe("slack-deliver endpoint", () => {
  test("returns 401 when auth is required and missing", async () => {
    // Ensure bypass is not active — clear APP_VERSION so the production guard blocks it
    delete process.env.APP_VERSION;
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest({ chatId: "C123", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("returns 200 with valid payload containing chatId and text", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest({ chatId: "C123", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify the Slack API was called with the correct payload
    const slackCall = fetchCalls.find((c) =>
      c.url.includes("chat.postMessage"),
    );
    expect(slackCall).toBeDefined();
    expect((slackCall!.body as any).channel).toBe("C123");
    expect((slackCall!.body as any).text).toBe("hello");
  });

  test("threadTs query param gets passed as thread_ts to Slack API", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest(
      { chatId: "C123", text: "reply in thread" },
      undefined,
      "?threadTs=1700000000.000050",
    );
    const res = await handler(req);
    expect(res.status).toBe(200);

    const slackCall = fetchCalls.find((c) =>
      c.url.includes("chat.postMessage"),
    );
    expect(slackCall).toBeDefined();
    expect((slackCall!.body as any).thread_ts).toBe("1700000000.000050");
  });

  test("returns 400 when chatId/to is missing", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest({ text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("chatId is required");
  });

  test("returns 503 when bot token is not configured", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(undefined),
    );
    const req = makeRequest({ chatId: "C123", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain("not configured");
  });

  test("force-refreshes credential cache when bot token is initially missing", async () => {
    let callCount = 0;
    const credentials = {
      get: async (key: string, opts?: { force?: boolean }) => {
        if (key === credentialKey("slack_channel", "bot_token")) {
          callCount++;
          // First call returns undefined; second call with force returns the token
          if (callCount === 1 && !opts?.force) return undefined;
          if (callCount === 2 && opts?.force) return "xoxb-refreshed-token";
        }
        return undefined;
      },
      invalidate: () => {},
    } as unknown as CredentialCache;

    const handler = createSlackDeliverHandler(makeConfig(), undefined, {
      credentials,
      configFile: makeConfigFile(),
    });
    const req = makeRequest({ chatId: "C123", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(callCount).toBe(2);

    // Verify the Slack API was called with the refreshed token
    const slackCall = fetchCalls.find((c) =>
      c.url.includes("chat.postMessage"),
    );
    expect(slackCall).toBeDefined();
    expect(slackCall!.headers!["authorization"]).toBe(
      "Bearer xoxb-refreshed-token",
    );
  });

  test("accepts 'to' as alias for chatId", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest({ to: "C_TO_CHAN", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(200);

    const slackCall = fetchCalls.find((c) =>
      c.url.includes("chat.postMessage"),
    );
    expect(slackCall).toBeDefined();
    expect((slackCall!.body as any).channel).toBe("C_TO_CHAN");
  });

  test("returns 400 when both text and attachments are missing", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest({ chatId: "C123" });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("text or attachments required");
  });

  test("returns 400 for invalid JSON", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = new Request("http://localhost:7830/deliver/slack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON");
  });

  test("returns 405 for GET requests", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = new Request("http://localhost:7830/deliver/slack", {
      method: "GET",
    });
    const res = await handler(req);
    expect(res.status).toBe(405);
  });

  test("sends Authorization header with bot token to Slack API", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches("xoxb-my-secret-token"),
    );
    const req = makeRequest({ chatId: "C123", text: "hello" });
    await handler(req);

    const slackCall = fetchCalls.find((c) =>
      c.url.includes("chat.postMessage"),
    );
    expect(slackCall).toBeDefined();
    expect(slackCall!.headers!["authorization"]).toBe(
      "Bearer xoxb-my-secret-token",
    );
  });

  test("returns 502 when Slack API returns ok: false with auth error", async () => {
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({ ok: false, error: "invalid_auth" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest({ chatId: "C123", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(502);
  });

  test("returns 404 when Slack API returns channel_not_found", async () => {
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({ ok: false, error: "channel_not_found" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest({ chatId: "C123", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(404);
  });

  test("does not include thread_ts when threadTs query param is absent", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest({ chatId: "C123", text: "hello" });
    await handler(req);

    const slackCall = fetchCalls.find((c) =>
      c.url.includes("chat.postMessage"),
    );
    expect(slackCall).toBeDefined();
    expect((slackCall!.body as any).thread_ts).toBeUndefined();
  });

  test("auto-formats text into Block Kit blocks when useBlocks is true", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest({
      chatId: "C123",
      text: "# Hello\n\nWorld",
      useBlocks: true,
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    const slackCall = fetchCalls.find((c) =>
      c.url.includes("chat.postMessage"),
    );
    expect(slackCall).toBeDefined();
    const body = slackCall!.body as any;
    // text fallback is always present
    expect(body.text).toBe("# Hello\n\nWorld");
    // blocks should be auto-generated
    expect(body.blocks).toBeDefined();
    expect(Array.isArray(body.blocks)).toBe(true);
    expect(body.blocks.length).toBeGreaterThan(0);
    // First block should be a header from "# Hello"
    expect(body.blocks[0].type).toBe("header");
    expect(body.blocks[0].text.text).toBe("Hello");
  });

  test("uses provided blocks when passed in request body", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const customBlocks = [
      { type: "section", text: { type: "mrkdwn", text: "Custom block" } },
    ];
    const req = makeRequest({
      chatId: "C123",
      text: "fallback text",
      blocks: customBlocks,
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    const slackCall = fetchCalls.find((c) =>
      c.url.includes("chat.postMessage"),
    );
    expect(slackCall).toBeDefined();
    const body = slackCall!.body as any;
    expect(body.text).toBe("fallback text");
    expect(body.blocks).toEqual(customBlocks);
  });

  test("always includes text as fallback alongside blocks", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest({
      chatId: "C123",
      text: "Simple message",
      useBlocks: true,
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    const slackCall = fetchCalls.find((c) =>
      c.url.includes("chat.postMessage"),
    );
    expect(slackCall).toBeDefined();
    const body = slackCall!.body as any;
    // text must always be present for notifications/accessibility
    expect(body.text).toBe("Simple message");
    // blocks are also present from auto-formatting
    expect(body.blocks).toBeDefined();
  });

  test("returns 400 when text is a non-string truthy value", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest({ chatId: "C123", text: { x: 1 } });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("text must be a string");
  });

  test("returns 400 when attachment is missing an id", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest({
      chatId: "C123",
      text: "hello",
      attachments: [{ filename: "no-id.png" }],
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("each attachment must have an id");
  });

  test("returns 400 when attachments is not an array", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest({
      chatId: "C123",
      text: "hello",
      attachments: "not-array",
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("attachments must be an array");
  });

  test("uses chat.postEphemeral when ephemeral flag is set", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest({
      chatId: "C123",
      text: "secret info",
      ephemeral: true,
      user: "U456",
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    const slackCall = fetchCalls.find((c) =>
      c.url.includes("chat.postEphemeral"),
    );
    expect(slackCall).toBeDefined();
    expect((slackCall!.body as any).channel).toBe("C123");
    expect((slackCall!.body as any).text).toBe("secret info");
    expect((slackCall!.body as any).user).toBe("U456");

    // Should NOT call chat.postMessage
    const postMessageCall = fetchCalls.find((c) =>
      c.url.includes("chat.postMessage"),
    );
    expect(postMessageCall).toBeUndefined();
  });

  test("returns 400 when ephemeral is set but user is missing", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest({
      chatId: "C123",
      text: "secret info",
      ephemeral: true,
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("user is required");
  });

  test("returns 400 when ephemeral message includes attachments", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest({
      chatId: "C123",
      text: "secret info",
      ephemeral: true,
      user: "U456",
      attachments: [
        {
          id: "att-img",
          filename: "photo.png",
          mimeType: "image/png",
          sizeBytes: 100,
        },
      ],
    });
    const res = await handler(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe(
      "attachments are not supported for ephemeral messages",
    );

    const uploadCall = fetchCalls.find((c) =>
      c.url.includes("files.completeUploadExternal"),
    );
    expect(uploadCall).toBeUndefined();
  });

  test("ephemeral message includes thread_ts when threadTs query param is set", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest(
      {
        chatId: "C123",
        text: "ephemeral in thread",
        ephemeral: true,
        user: "U789",
      },
      undefined,
      "?threadTs=1700000000.000100",
    );
    const res = await handler(req);
    expect(res.status).toBe(200);

    const slackCall = fetchCalls.find((c) =>
      c.url.includes("chat.postEphemeral"),
    );
    expect(slackCall).toBeDefined();
    expect((slackCall!.body as any).thread_ts).toBe("1700000000.000100");
    expect((slackCall!.body as any).user).toBe("U789");
  });

  test("does not call onThreadReply for ephemeral messages in a thread", async () => {
    const onThreadReply = mock(() => {});
    const handler = createSlackDeliverHandler(
      makeConfig(),
      onThreadReply,
      makeCaches(),
    );
    const req = makeRequest(
      {
        chatId: "C123",
        text: "ephemeral thread msg",
        ephemeral: true,
        user: "U456",
      },
      undefined,
      "?threadTs=1700000000.000200",
    );
    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(onThreadReply).not.toHaveBeenCalled();
  });

  test("calls onThreadReply for non-ephemeral messages in a thread", async () => {
    const onThreadReply = mock(() => {});
    const handler = createSlackDeliverHandler(
      makeConfig(),
      onThreadReply,
      makeCaches(),
    );
    const req = makeRequest(
      { chatId: "C123", text: "normal thread msg" },
      undefined,
      "?threadTs=1700000000.000300",
    );
    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(onThreadReply).toHaveBeenCalledWith("1700000000.000300");
  });

  test("uses chat.update when messageTs is provided", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest({
      chatId: "C123",
      text: "updated text",
      messageTs: "1700000000.000050",
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    const updateCall = fetchCalls.find((c) => c.url.includes("chat.update"));
    expect(updateCall).toBeDefined();
    expect((updateCall!.body as any).channel).toBe("C123");
    expect((updateCall!.body as any).text).toBe("updated text");
    expect((updateCall!.body as any).ts).toBe("1700000000.000050");

    // Should not have called chat.postMessage
    const postCall = fetchCalls.find((c) => c.url.includes("chat.postMessage"));
    expect(postCall).toBeUndefined();
  });

  test("chat.update does not include thread_ts", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest(
      {
        chatId: "C123",
        text: "threaded update",
        messageTs: "1700000000.000050",
      },
      undefined,
      "?threadTs=1700000000.000001",
    );
    const res = await handler(req);
    expect(res.status).toBe(200);

    const updateCall = fetchCalls.find((c) => c.url.includes("chat.update"));
    expect(updateCall).toBeDefined();
    expect((updateCall!.body as any).thread_ts).toBeUndefined();
    expect((updateCall!.body as any).ts).toBe("1700000000.000050");
  });

  test("falls back to chat.postMessage when chat.update fails", async () => {
    fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        let body: unknown;
        try {
          if (init?.body) body = JSON.parse(String(init.body));
        } catch {
          /* not JSON */
        }
        const headers: Record<string, string> = {};
        if (init?.headers) {
          const h = init.headers;
          if (h && typeof h === "object" && !Array.isArray(h)) {
            for (const [k, v] of Object.entries(h)) {
              headers[k.toLowerCase()] = v;
            }
          }
        }
        fetchCalls.push({ url, body, headers });

        if (url.includes("chat.update")) {
          return new Response(
            JSON.stringify({ ok: false, error: "message_not_found" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("chat.postMessage")) {
          return new Response(
            JSON.stringify({ ok: true, ts: "1700000000.000200" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("Not found", { status: 404 });
      },
    );

    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest({
      chatId: "C123",
      text: "update attempt",
      messageTs: "1700000000.000050",
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    // Should have called both: first update (failed), then postMessage (fallback)
    const updateCall = fetchCalls.find((c) => c.url.includes("chat.update"));
    expect(updateCall).toBeDefined();
    const postCall = fetchCalls.find((c) => c.url.includes("chat.postMessage"));
    expect(postCall).toBeDefined();
    // Fallback should not include the ts field
    expect((postCall!.body as any).ts).toBeUndefined();
  });

  test("does not use chat.update when messageTs is empty string", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest({
      chatId: "C123",
      text: "normal post",
      messageTs: "",
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    const postCall = fetchCalls.find((c) => c.url.includes("chat.postMessage"));
    expect(postCall).toBeDefined();
    const updateCall = fetchCalls.find((c) => c.url.includes("chat.update"));
    expect(updateCall).toBeUndefined();
  });
});

describe("slack attachment delivery", () => {
  test("uploads image attachment via files.getUploadURLExternal flow", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest({
      chatId: "C123",
      text: "Here is a photo",
      attachments: [
        {
          id: "att-img",
          filename: "photo.png",
          mimeType: "image/png",
          sizeBytes: 100,
        },
      ],
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    // Should have called: chat.postMessage, download attachment, getUploadURLExternal, upload to URL, completeUploadExternal
    const downloadCall = fetchCalls.find((c) =>
      c.url.includes("/v1/attachments/att-img"),
    );
    expect(downloadCall).toBeDefined();

    const getUrlCall = fetchCalls.find((c) =>
      c.url.includes("files.getUploadURLExternal"),
    );
    expect(getUrlCall).toBeDefined();

    const completeCall = fetchCalls.find((c) =>
      c.url.includes("files.completeUploadExternal"),
    );
    expect(completeCall).toBeDefined();
    expect((completeCall!.body as any).channel_id).toBe("C123");
  });

  test("uploads document attachment (pdf)", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest({
      chatId: "C123",
      text: "Here is a report",
      attachments: [
        {
          id: "att-pdf",
          filename: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 200,
        },
      ],
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    const downloadCall = fetchCalls.find((c) =>
      c.url.includes("/v1/attachments/att-pdf"),
    );
    expect(downloadCall).toBeDefined();

    const getUrlCall = fetchCalls.find((c) =>
      c.url.includes("files.getUploadURLExternal"),
    );
    expect(getUrlCall).toBeDefined();
  });

  test("skips oversized attachment and sends failure notice", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig({ maxAttachmentBytes: 50 }),
      undefined,
      makeCaches(),
    );
    const req = makeRequest({
      chatId: "C123",
      text: "hello",
      attachments: [
        {
          id: "att-img",
          filename: "photo.png",
          mimeType: "image/png",
          sizeBytes: 100, // exceeds 50 byte limit
        },
      ],
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    // Should not have downloaded the attachment
    const downloadCall = fetchCalls.find((c) =>
      c.url.includes("/v1/attachments/att-img"),
    );
    expect(downloadCall).toBeUndefined();

    // Should have sent the text message and the failure notice
    const messageCalls = fetchCalls.filter((c) =>
      c.url.includes("chat.postMessage"),
    );
    expect(messageCalls.length).toBe(2); // original text + failure notice
  });

  test("delivers attachments-only request without text", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest({
      chatId: "C123",
      attachments: [
        {
          id: "att-img",
          filename: "photo.png",
          mimeType: "image/png",
          sizeBytes: 100,
        },
      ],
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    // No chat.postMessage for text since text was absent
    const textCall = fetchCalls.find(
      (c) =>
        c.url.includes("chat.postMessage") &&
        (c.body as any)?.text !== undefined &&
        !(c.body as any)?.text?.includes("could not be delivered"),
    );
    expect(textCall).toBeUndefined();

    // But should have downloaded and uploaded the attachment
    const downloadCall = fetchCalls.find((c) =>
      c.url.includes("/v1/attachments/att-img"),
    );
    expect(downloadCall).toBeDefined();
  });

  test("continues sending remaining attachments on individual failure", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest({
      chatId: "C123",
      text: "hello",
      attachments: [
        {
          id: "att-fail",
          filename: "bad.png",
          mimeType: "image/png",
          sizeBytes: 50,
        },
        {
          id: "att-ok",
          filename: "good.png",
          mimeType: "image/png",
          sizeBytes: 50,
        },
      ],
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    // Second attachment should still be downloaded and uploaded
    const okDownload = fetchCalls.find((c) =>
      c.url.includes("/v1/attachments/att-ok"),
    );
    expect(okDownload).toBeDefined();

    // Should send failure notice for the failed attachment
    const noticeCalls = fetchCalls.filter(
      (c) =>
        c.url.includes("chat.postMessage") &&
        typeof (c.body as any)?.text === "string" &&
        (c.body as any).text.includes("could not be delivered"),
    );
    expect(noticeCalls.length).toBe(1);
  });

  test("passes threadTs to file upload completeUploadExternal", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig(),
      undefined,
      makeCaches(),
    );
    const req = makeRequest(
      {
        chatId: "C123",
        text: "threaded attachment",
        attachments: [
          {
            id: "att-img",
            filename: "photo.png",
            mimeType: "image/png",
            sizeBytes: 100,
          },
        ],
      },
      undefined,
      "?threadTs=1700000000.000050",
    );
    const res = await handler(req);
    expect(res.status).toBe(200);

    const completeCall = fetchCalls.find((c) =>
      c.url.includes("files.completeUploadExternal"),
    );
    expect(completeCall).toBeDefined();
    expect((completeCall!.body as any).thread_ts).toBe("1700000000.000050");
  });
});
