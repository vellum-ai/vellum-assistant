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

let mockMetadata: { accountInfo?: string } | undefined;
let mockSecureKey: string | undefined;
let mockUpsertCalls: Array<{
  service: string;
  key: string;
  patch: Record<string, unknown>;
}> = [];

mock.module("../tools/credentials/metadata-store.js", () => ({
  getCredentialMetadata: (_service: string, _key: string) => mockMetadata,
  upsertCredentialMetadata: (
    service: string,
    key: string,
    patch: Record<string, unknown>,
  ) => {
    mockUpsertCalls.push({ service, key, patch });
  },
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (_keyId: string) => mockSecureKey,
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
  mockMetadata = undefined;
  mockSecureKey = undefined;
  mockUpsertCalls = [];
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
  test("(a) early-returns when accountInfo is already cached", async () => {
    mockMetadata = { accountInfo: "CachedBot" };
    mockSecureKey = "some-token";

    await ensureTelegramBotUsernameResolved();

    expect(fetchCallCount).toBe(0);
    expect(mockUpsertCalls).toHaveLength(0);
  });

  test("(b) fetches getMe and caches username on success", async () => {
    mockMetadata = undefined;
    mockSecureKey = "bot-token-123";
    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { username: "MyNewBot" } }),
    };

    await ensureTelegramBotUsernameResolved();

    expect(fetchCallCount).toBe(1);
    expect(mockUpsertCalls).toEqual([
      {
        service: "telegram",
        key: "bot_token",
        patch: { accountInfo: "MyNewBot" },
      },
    ]);
  });

  test("(c) handles non-200 response gracefully without caching", async () => {
    mockMetadata = undefined;
    mockSecureKey = "bot-token-123";
    mockFetchResponse = {
      ok: false,
      status: 401,
      json: async () => ({ ok: false, description: "Unauthorized" }),
    };

    await ensureTelegramBotUsernameResolved();

    expect(fetchCallCount).toBe(1);
    expect(mockUpsertCalls).toHaveLength(0);
  });

  test("(d) handles missing username in response gracefully", async () => {
    mockMetadata = undefined;
    mockSecureKey = "bot-token-123";
    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };

    await ensureTelegramBotUsernameResolved();

    expect(fetchCallCount).toBe(1);
    expect(mockUpsertCalls).toHaveLength(0);
  });

  test("(e) handles network errors (fetch throws) gracefully", async () => {
    mockMetadata = undefined;
    mockSecureKey = "bot-token-123";
    mockFetchThrows = new Error("ECONNREFUSED");

    await ensureTelegramBotUsernameResolved();

    expect(fetchCallCount).toBe(1);
    expect(mockUpsertCalls).toHaveLength(0);
  });

  test("(f) no-ops when no bot token is configured", async () => {
    mockMetadata = undefined;
    mockSecureKey = undefined;

    await ensureTelegramBotUsernameResolved();

    expect(fetchCallCount).toBe(0);
    expect(mockUpsertCalls).toHaveLength(0);
  });

  test("treats whitespace-only accountInfo as uncached", async () => {
    mockMetadata = { accountInfo: "   " };
    mockSecureKey = "bot-token-123";
    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { username: "FreshBot" } }),
    };

    await ensureTelegramBotUsernameResolved();

    expect(fetchCallCount).toBe(1);
    expect(mockUpsertCalls).toEqual([
      {
        service: "telegram",
        key: "bot_token",
        patch: { accountInfo: "FreshBot" },
      },
    ]);
  });

  test("treats empty-string accountInfo as uncached", async () => {
    mockMetadata = { accountInfo: "" };
    mockSecureKey = "bot-token-456";
    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { username: "AnotherBot" } }),
    };

    await ensureTelegramBotUsernameResolved();

    expect(fetchCallCount).toBe(1);
    expect(mockUpsertCalls).toEqual([
      {
        service: "telegram",
        key: "bot_token",
        patch: { accountInfo: "AnotherBot" },
      },
    ]);
  });
});
