import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import type { ApprovalPayload } from "../http/routes/telegram-deliver.js";
import type { GatewayConfig } from "../config.js";
import type { CredentialCache } from "../credential-cache.js";
import type { ConfigFileCache } from "../config-file-cache.js";
import { credentialKey } from "../credential-key.js";

// Mock fetch at the transport level (same pattern as all other test files)
// instead of mocking ./api.js — mock.module for api.js leaks across test
// files in the same Bun process, poisoning callTelegramApi for other tests.
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

const { buildInlineKeyboard, sendTelegramReply } = await import("./send.js");

const baseConfig: GatewayConfig = {
  assistantRuntimeBaseUrl: "http://localhost:7821",
  defaultAssistantId: undefined,
  gatewayInternalBaseUrl: "http://127.0.0.1:7830",
  logFile: { dir: undefined, retentionDays: 30 },
  maxAttachmentBytes: {
    telegram: 50 * 1024 * 1024,
    slack: 100 * 1024 * 1024,
    whatsapp: 16 * 1024 * 1024,
    default: 50 * 1024 * 1024,
  },
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
  unmappedPolicy: "reject",
  trustProxy: false,
};

const sampleApproval: ApprovalPayload = {
  requestId: "req-456",
  actions: [
    { id: "approve_once", label: "Approve once" },
    { id: "approve_always", label: "Approve always" },
    { id: "reject", label: "Reject" },
  ],
  plainTextFallback: "Reply: approve, always, or reject",
};

/** Mock credential cache providing test bot token. */
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

function makeTelegramResponse(result: unknown) {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

let fetchCalls: { url: string; body: unknown }[];

beforeEach(() => {
  fetchCalls = [];
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
        /* FormData or non-JSON body */
      }
      fetchCalls.push({ url, body });
      return makeTelegramResponse({});
    },
  );
});

afterEach(() => {
  fetchMock = mock(async () => new Response());
});

describe("buildInlineKeyboard", () => {
  it("maps each action to its own row with compact callback data", () => {
    const result = buildInlineKeyboard(sampleApproval);

    expect(result.inline_keyboard).toHaveLength(3);
    expect(result.inline_keyboard[0]).toEqual([
      { text: "Approve once", callback_data: "apr:req-456:approve_once" },
    ]);
    expect(result.inline_keyboard[1]).toEqual([
      { text: "Approve always", callback_data: "apr:req-456:approve_always" },
    ]);
    expect(result.inline_keyboard[2]).toEqual([
      { text: "Reject", callback_data: "apr:req-456:reject" },
    ]);
  });

  it("handles a single action", () => {
    const approval: ApprovalPayload = {
      requestId: "rq1",
      actions: [{ id: "ok", label: "OK" }],
      plainTextFallback: "ok",
    };
    const result = buildInlineKeyboard(approval);
    expect(result.inline_keyboard).toHaveLength(1);
    expect(result.inline_keyboard[0][0].callback_data).toBe("apr:rq1:ok");
  });

  it("uses compact callback data format apr:<requestId>:<actionId>", () => {
    const approval: ApprovalPayload = {
      requestId: "abc-def",
      actions: [{ id: "my_action", label: "Do it" }],
      plainTextFallback: "do it",
    };
    const result = buildInlineKeyboard(approval);
    expect(result.inline_keyboard[0][0].callback_data).toBe(
      "apr:abc-def:my_action",
    );
  });

  it("throws when callback_data exceeds 64 bytes", () => {
    const approval: ApprovalPayload = {
      requestId: "r".repeat(60),
      actions: [{ id: "action", label: "Go" }],
      plainTextFallback: "go",
    };
    expect(() => buildInlineKeyboard(approval)).toThrow("64-byte limit");
  });

  it("accepts callback_data exactly at 64 bytes", () => {
    // "apr:" = 4 bytes, ":" = 1 byte, so requestId + actionId = 59 bytes
    const requestId = "r".repeat(50);
    const actionId = "a".repeat(9);
    const approval: ApprovalPayload = {
      requestId,
      actions: [{ id: actionId, label: "Go" }],
      plainTextFallback: "go",
    };
    expect(Buffer.byteLength(`apr:${requestId}:${actionId}`)).toBe(64);
    const result = buildInlineKeyboard(approval);
    expect(result.inline_keyboard[0][0].callback_data).toBe(
      `apr:${requestId}:${actionId}`,
    );
  });
});

describe("sendTelegramReply", () => {
  it("sends a plain message without reply_markup when no approval", async () => {
    await sendTelegramReply(baseConfig, "chat-1", "Hello", undefined, testOpts);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("/sendMessage");
    const body = fetchCalls[0].body as Record<string, unknown>;
    expect(body.chat_id).toBe("chat-1");
    expect(body.text).toBe("Hello");
    expect(body.reply_markup).toBeUndefined();
  });

  it("attaches inline keyboard when approval is provided", async () => {
    await sendTelegramReply(
      baseConfig,
      "chat-1",
      "Approve?",
      sampleApproval,
      testOpts,
    );

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("/sendMessage");
    const body = fetchCalls[0].body as Record<string, unknown>;
    expect(body.reply_markup).toBeDefined();

    const markup = body.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(markup.inline_keyboard).toHaveLength(3);
    expect(markup.inline_keyboard[0][0].callback_data).toBe(
      "apr:req-456:approve_once",
    );
  });

  it("attaches inline keyboard only to the last chunk for long messages", async () => {
    // Create a message that exceeds TELEGRAM_MAX_MESSAGE_LEN (4000 chars)
    const longText = "A".repeat(4001);
    await sendTelegramReply(
      baseConfig,
      "chat-1",
      longText,
      sampleApproval,
      testOpts,
    );

    expect(fetchCalls).toHaveLength(2);

    const firstBody = fetchCalls[0].body as Record<string, unknown>;
    expect(firstBody.reply_markup).toBeUndefined();

    const lastBody = fetchCalls[1].body as Record<string, unknown>;
    expect(lastBody.reply_markup).toBeDefined();
  });
});
