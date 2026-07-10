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

const { loadMcpTokenEnvelope, persistMcpTokens } =
  await import("../mcp-oauth-provider.js");
const { markMcpNeedsReauth, mcpNeedsReauth } =
  await import("../mcp-auth-state.js");

const SERVER_ID = "srv-tokens";
const TOKENS_KEY = `mcp:${SERVER_ID}:tokens`;

describe("MCP token envelope persistence", () => {
  beforeEach(() => {
    store.clear();
  });

  test("persists an absolute expiry derived from expires_in", async () => {
    const before = Date.now();
    const ok = await persistMcpTokens(SERVER_ID, {
      access_token: "at-1",
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "rt-1",
    });
    expect(ok).toBe(true);

    const envelope = await loadMcpTokenEnvelope(SERVER_ID);
    expect(envelope).not.toBeNull();
    expect(envelope!.tokens.access_token).toBe("at-1");
    expect(envelope!.tokens.refresh_token).toBe("rt-1");
    expect(envelope!.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(envelope!.expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
  });

  test("omits expiresAt when the server omits expires_in", async () => {
    await persistMcpTokens(SERVER_ID, {
      access_token: "at-2",
      token_type: "bearer",
    });
    const envelope = await loadMcpTokenEnvelope(SERVER_ID);
    expect(envelope!.tokens.access_token).toBe("at-2");
    expect(envelope!.expiresAt).toBeUndefined();
  });

  test("tolerates legacy blobs stored as bare OAuthTokens", async () => {
    // A pre-envelope install persisted the raw OAuthTokens JSON.
    store.set(
      TOKENS_KEY,
      JSON.stringify({
        access_token: "legacy-at",
        token_type: "bearer",
        refresh_token: "legacy-rt",
      }),
    );

    const envelope = await loadMcpTokenEnvelope(SERVER_ID);
    expect(envelope).not.toBeNull();
    expect(envelope!.tokens.access_token).toBe("legacy-at");
    expect(envelope!.tokens.refresh_token).toBe("legacy-rt");
    expect(envelope!.expiresAt).toBeUndefined();
  });

  test("returns null when no tokens are stored", async () => {
    expect(await loadMcpTokenEnvelope(SERVER_ID)).toBeNull();
  });

  test("clears a needs-reauth marker on successful persist", async () => {
    markMcpNeedsReauth(SERVER_ID);
    expect(mcpNeedsReauth(SERVER_ID)).toBe(true);

    await persistMcpTokens(SERVER_ID, {
      access_token: "at-3",
      token_type: "bearer",
    });
    expect(mcpNeedsReauth(SERVER_ID)).toBe(false);
  });
});
