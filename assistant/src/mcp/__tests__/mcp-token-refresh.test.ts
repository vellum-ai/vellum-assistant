import { beforeEach, describe, expect, mock, test } from "bun:test";

// In-memory secure-key store shared by the provider under test.
const store = new Map<string, string>();

mock.module("../../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (k: string) => store.get(k) ?? null,
  setSecureKeyAsync: async (k: string, v: string) => {
    store.set(k, v);
    return true;
  },
  deleteSecureKeyAsync: async (k: string) => {
    const had = store.has(k);
    store.delete(k);
    return had ? "deleted" : "not-found";
  },
}));

// Mock the SDK auth module: refreshAuthorization is driven per-test; the other
// exports are kept trivial. UnauthorizedError is re-exported because the OAuth
// provider imports it from the same module.
let refreshCalls = 0;
let refreshImpl: (args: {
  refreshToken: string;
}) => Promise<Record<string, unknown>> = async () => ({
  access_token: "new-access",
  token_type: "bearer",
  expires_in: 3600,
  refresh_token: "new-refresh",
});

mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: class extends Error {},
  refreshAuthorization: async (
    _url: unknown,
    args: { refreshToken: string },
  ) => {
    refreshCalls++;
    return refreshImpl(args);
  },
  selectResourceURL: async () => undefined,
  discoverAuthorizationServerMetadata: async () => ({
    token_endpoint: "https://as.example.com/token",
  }),
}));

const { refreshMcpTokens } = await import("../mcp-token-refresh.js");
const { loadMcpTokenEnvelope } = await import("../mcp-oauth-provider.js");

const SERVER_ID = "srv-refresh";
const SERVER_URL = "https://mcp.example.com/mcp";

function seedFullCredentials(refreshToken = "rt-old"): void {
  store.set(
    `mcp:${SERVER_ID}:tokens`,
    JSON.stringify({
      tokens: {
        access_token: "at-old",
        token_type: "bearer",
        refresh_token: refreshToken,
      },
    }),
  );
  store.set(
    `mcp:${SERVER_ID}:client_info`,
    JSON.stringify({ client_id: "client-abc" }),
  );
  store.set(
    `mcp:${SERVER_ID}:discovery`,
    JSON.stringify({
      authorizationServerUrl: "https://as.example.com",
      authorizationServerMetadata: {
        token_endpoint: "https://as.example.com/token",
      },
    }),
  );
}

describe("refreshMcpTokens", () => {
  beforeEach(() => {
    store.clear();
    refreshCalls = 0;
    refreshImpl = async () => ({
      access_token: "new-access",
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "new-refresh",
    });
  });

  test("happy path — refreshes and persists new tokens", async () => {
    seedFullCredentials();
    const ok = await refreshMcpTokens(SERVER_ID, SERVER_URL);
    expect(ok).toBe(true);
    expect(refreshCalls).toBe(1);

    const envelope = await loadMcpTokenEnvelope(SERVER_ID);
    expect(envelope!.tokens.access_token).toBe("new-access");
    expect(envelope!.tokens.refresh_token).toBe("new-refresh");
    expect(envelope!.expiresAt).toBeGreaterThan(Date.now());
  });

  test("returns false when no refresh token is stored", async () => {
    store.set(
      `mcp:${SERVER_ID}:tokens`,
      JSON.stringify({ tokens: { access_token: "at", token_type: "bearer" } }),
    );
    store.set(
      `mcp:${SERVER_ID}:client_info`,
      JSON.stringify({ client_id: "client-abc" }),
    );
    const ok = await refreshMcpTokens(SERVER_ID, SERVER_URL);
    expect(ok).toBe(false);
    expect(refreshCalls).toBe(0);
  });

  test("returns false when client registration is missing", async () => {
    store.set(
      `mcp:${SERVER_ID}:tokens`,
      JSON.stringify({
        tokens: {
          access_token: "at",
          token_type: "bearer",
          refresh_token: "rt",
        },
      }),
    );
    const ok = await refreshMcpTokens(SERVER_ID, SERVER_URL);
    expect(ok).toBe(false);
    expect(refreshCalls).toBe(0);
  });

  test("returns false and preserves tokens when the refresh request fails", async () => {
    seedFullCredentials();
    refreshImpl = async () => {
      throw new Error("invalid_grant");
    };
    const ok = await refreshMcpTokens(SERVER_ID, SERVER_URL);
    expect(ok).toBe(false);

    const envelope = await loadMcpTokenEnvelope(SERVER_ID);
    expect(envelope!.tokens.access_token).toBe("at-old");
  });

  test("single-flight — concurrent refreshes share one token request", async () => {
    seedFullCredentials();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    refreshImpl = async () => {
      await gate;
      return {
        access_token: "concurrent-access",
        token_type: "bearer",
        refresh_token: "concurrent-refresh",
      };
    };

    const p1 = refreshMcpTokens(SERVER_ID, SERVER_URL);
    const p2 = refreshMcpTokens(SERVER_ID, SERVER_URL);
    release!();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(refreshCalls).toBe(1);
  });
});
