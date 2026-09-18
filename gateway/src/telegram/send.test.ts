import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
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

const { sendTelegramReply } = await import("./send.js");

const baseConfig: GatewayConfig = {
  assistantRuntimeBaseUrl: "http://localhost:7821",
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
  runtimeProxyRequireAuth: true,
  runtimeTimeoutMs: 30000,
  shutdownDrainMs: 5000,
  trustProxy: false,
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

describe("sendTelegramReply", () => {
  it("sends a plain message without reply_markup", async () => {
    await sendTelegramReply(baseConfig, "chat-1", "Hello", testOpts);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("/sendMessage");
    const body = fetchCalls[0].body as Record<string, unknown>;
    expect(body.chat_id).toBe("chat-1");
    expect(body.text).toBe("Hello");
    expect(body.reply_markup).toBeUndefined();
  });

  it("splits long text into one sendMessage per chunk", async () => {
    // Exceeds TELEGRAM_MAX_MESSAGE_LEN (4000 chars)
    const longText = "A".repeat(4001);
    await sendTelegramReply(baseConfig, "chat-1", longText, testOpts);

    expect(fetchCalls).toHaveLength(2);
    for (const call of fetchCalls) {
      expect(call.url).toContain("/sendMessage");
      const body = call.body as Record<string, unknown>;
      expect(body.chat_id).toBe("chat-1");
      expect(body.reply_markup).toBeUndefined();
    }
    const sentText = fetchCalls
      .map((call) => (call.body as Record<string, unknown>).text)
      .join("");
    expect(sentText).toBe(longText);
  });
});
