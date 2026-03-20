/**
 * Tests for `ensureTelegramBotUsernameResolved()`.
 *
 * This function fills the bot-username gap when the token was configured
 * without a `getMe` call (e.g. via `credential set` or ingress secret
 * redirect). Each branch is exercised in isolation by controlling the
 * mutable mock variables below.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mutable mock state — tests toggle these before each call
// ---------------------------------------------------------------------------

let mockBotUsername: string | undefined;
let mockSecureKey: string | undefined;
let mockConfigWriteCalls: Array<{
  path: string;
  value: unknown;
}> = [];

mock.module("../telegram/bot-username.js", () => ({
  getTelegramBotUsername: () => mockBotUsername,
  getTelegramBotId: () => (mockBotUsername ? "123456" : undefined),
}));

mock.module("../config/loader.js", () => ({
  loadRawConfig: () => ({}),
  setNestedValue: (
    _obj: Record<string, unknown>,
    path: string,
    value: unknown,
  ) => {
    mockConfigWriteCalls.push({ path, value });
  },
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (_keyId: string) => ({
    value: mockSecureKey,
    unreachable: false,
  }),
}));

// Suppress logger output during tests
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ---------------------------------------------------------------------------
// Global fetch mock — swapped per test
// ---------------------------------------------------------------------------

let mockFetchResponse: {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};
let mockFetchThrows: Error | undefined;
let fetchCallCount = 0;

beforeEach(() => {
  mockBotUsername = undefined;
  mockSecureKey = undefined;
  mockConfigWriteCalls = [];
  mockFetchThrows = undefined;
  mockFetchResponse = {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { username: "ResolvedBot" } }),
  };
  fetchCallCount = 0;

  globalThis.fetch = (async (..._args: unknown[]) => {
    fetchCallCount++;
    if (mockFetchThrows) throw mockFetchThrows;
    return mockFetchResponse;
  }) as typeof globalThis.fetch;
});

// ---------------------------------------------------------------------------
// Import under test — AFTER mocks are registered
// ---------------------------------------------------------------------------

const { ensureTelegramBotUsernameResolved } =
  await import("../runtime/channel-invite-transports/telegram.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ensureTelegramBotUsernameResolved", () => {
  test("(a) early-returns when bot username is already cached in config", async () => {
    mockBotUsername = "CachedBot";
    mockSecureKey = "some-token";

    await ensureTelegramBotUsernameResolved();

    expect(fetchCallCount).toBe(0);
    expect(mockConfigWriteCalls).toHaveLength(0);
  });

  test("(b) fetches getMe and writes username to config on success", async () => {
    mockBotUsername = undefined;
    mockSecureKey = "bot-token-123";
    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { username: "MyNewBot" } }),
    };

    await ensureTelegramBotUsernameResolved();

    expect(fetchCallCount).toBe(1);
    expect(mockConfigWriteCalls).toEqual([
      {
        path: "telegram.botUsername",
        value: "MyNewBot",
      },
    ]);
  });

  test("(c) handles non-200 response gracefully without writing to config", async () => {
    mockBotUsername = undefined;
    mockSecureKey = "bot-token-123";
    mockFetchResponse = {
      ok: false,
      status: 401,
      json: async () => ({ ok: false, description: "Unauthorized" }),
    };

    await ensureTelegramBotUsernameResolved();

    expect(fetchCallCount).toBe(1);
    expect(mockConfigWriteCalls).toHaveLength(0);
  });

  test("(d) handles missing username in response gracefully", async () => {
    mockBotUsername = undefined;
    mockSecureKey = "bot-token-123";
    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };

    await ensureTelegramBotUsernameResolved();

    expect(fetchCallCount).toBe(1);
    expect(mockConfigWriteCalls).toHaveLength(0);
  });

  test("(e) handles network errors (fetch throws) gracefully", async () => {
    mockBotUsername = undefined;
    mockSecureKey = "bot-token-123";
    mockFetchThrows = new Error("ECONNREFUSED");

    await ensureTelegramBotUsernameResolved();

    expect(fetchCallCount).toBe(1);
    expect(mockConfigWriteCalls).toHaveLength(0);
  });

  test("(f) no-ops when no bot token is configured", async () => {
    mockBotUsername = undefined;
    mockSecureKey = undefined;

    await ensureTelegramBotUsernameResolved();

    expect(fetchCallCount).toBe(0);
    expect(mockConfigWriteCalls).toHaveLength(0);
  });

  test("writes to config when bot username not in config", async () => {
    mockBotUsername = undefined;
    mockSecureKey = "bot-token-123";
    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { username: "FreshBot" } }),
    };

    await ensureTelegramBotUsernameResolved();

    expect(fetchCallCount).toBe(1);
    expect(mockConfigWriteCalls).toEqual([
      {
        path: "telegram.botUsername",
        value: "FreshBot",
      },
    ]);
  });

  test("writes to config when bot username resolved from API", async () => {
    mockBotUsername = undefined;
    mockSecureKey = "bot-token-456";
    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { username: "AnotherBot" } }),
    };

    await ensureTelegramBotUsernameResolved();

    expect(fetchCallCount).toBe(1);
    expect(mockConfigWriteCalls).toEqual([
      {
        path: "telegram.botUsername",
        value: "AnotherBot",
      },
    ]);
  });
});
