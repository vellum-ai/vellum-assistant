/**
 * Tests for the Claude ACP OAuth renewal policy.
 *
 * Storage is mocked (it belongs to `acp-claude-oauth.ts`, tested separately) so
 * these assert only the decisions this module owns: when to spend the refresh
 * token, what to persist, and what to tear down when the provider rejects it.
 *
 * `isCredentialError` is deliberately NOT mocked. Whether a failure is
 * permanent or transient is the hinge of the whole module, and asserting it
 * against the real classifier is the only way these tests stay honest about
 * which thrown errors clear a user's stored credential.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { OAuth2TokenResult } from "../../security/oauth2.js";

// ---------------------------------------------------------------------------
// Mocks: wired BEFORE importing the module via dynamic import.
// ---------------------------------------------------------------------------

let expiring = false;
let storedRefreshToken: string | null = null;
let refreshImpl: () => Promise<OAuth2TokenResult> = async () => {
  throw new Error("refreshOAuth2Token not stubbed for this test");
};

const isAcpClaudeTokenExpiring = mock(async () => expiring);
const readAcpClaudeRefreshToken = mock(async () => storedRefreshToken);
const storeAcpClaudeTokens = mock(async (_tokens: unknown) => {});
const clearAcpClaudeRefreshMaterial = mock(async () => {});
const refreshOAuth2Token = mock(async (..._args: unknown[]) => refreshImpl());

mock.module("../acp-claude-oauth.js", () => ({
  CLAUDE_OAUTH_CONFIG: {
    tokenExchangeUrl: "https://platform.claude.com/v1/oauth/token",
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    tokenExchangeBodyFormat: "json",
  },
  isAcpClaudeTokenExpiring,
  readAcpClaudeRefreshToken,
  storeAcpClaudeTokens,
  clearAcpClaudeRefreshMaterial,
}));
mock.module("../../security/oauth2.js", () => ({ refreshOAuth2Token }));

const { ensureFreshAcpClaudeToken } =
  await import("../claude-token-refresh.js");

beforeEach(() => {
  expiring = false;
  storedRefreshToken = null;
  refreshImpl = async () => {
    throw new Error("refreshOAuth2Token not stubbed for this test");
  };
  isAcpClaudeTokenExpiring.mockClear();
  readAcpClaudeRefreshToken.mockClear();
  storeAcpClaudeTokens.mockClear();
  clearAcpClaudeRefreshMaterial.mockClear();
  refreshOAuth2Token.mockClear();
});

// ---------------------------------------------------------------------------
// When renewal is skipped
// ---------------------------------------------------------------------------

describe("ensureFreshAcpClaudeToken: skip paths", () => {
  test("does nothing while the token is still fresh", async () => {
    expiring = false;
    storedRefreshToken = "refresh-me";

    await ensureFreshAcpClaudeToken();

    expect(refreshOAuth2Token).not.toHaveBeenCalled();
    expect(storeAcpClaudeTokens).not.toHaveBeenCalled();
  });

  test("does nothing when expiring with no refresh token stored", async () => {
    // The pre-refresh-token connect. Nothing to spend, so the spawn proceeds
    // and fails at the adapter as auth_required, which raises the Connect card.
    expiring = true;
    storedRefreshToken = null;

    await ensureFreshAcpClaudeToken();

    expect(refreshOAuth2Token).not.toHaveBeenCalled();
    expect(clearAcpClaudeRefreshMaterial).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Successful renewal
// ---------------------------------------------------------------------------

describe("ensureFreshAcpClaudeToken: renewal", () => {
  test("refreshes against Claude's token endpoint and persists the rotated set", async () => {
    expiring = true;
    storedRefreshToken = "refresh-me";
    refreshImpl = async () => ({
      accessToken: "sk-ant-oat-new",
      refreshToken: "refresh-rotated",
      expiresIn: 3600,
    });

    await ensureFreshAcpClaudeToken();

    expect(refreshOAuth2Token).toHaveBeenCalledTimes(1);
    const args = refreshOAuth2Token.mock.calls[0];
    expect(args[0]).toBe("https://platform.claude.com/v1/oauth/token");
    expect(args[1]).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(args[2]).toBe("refresh-me");
    // PKCE public client: no secret, and Anthropic's endpoint needs a JSON body.
    expect(args[3]).toBeUndefined();
    expect(args[5]).toBe("json");

    // The ROTATED refresh token must be persisted, not the one we spent.
    expect(storeAcpClaudeTokens).toHaveBeenCalledWith({
      accessToken: "sk-ant-oat-new",
      refreshToken: "refresh-rotated",
      expiresIn: 3600,
    });
  });

  test("runs one refresh for concurrent spawns", async () => {
    // Anthropic rotates the refresh token on use, so a second concurrent
    // exchange would spend an already-invalidated token.
    expiring = true;
    storedRefreshToken = "refresh-me";
    let resolveRefresh: (v: OAuth2TokenResult) => void = () => {};
    refreshImpl = () =>
      new Promise<OAuth2TokenResult>((resolve) => {
        resolveRefresh = resolve;
      });

    const both = Promise.all([
      ensureFreshAcpClaudeToken(),
      ensureFreshAcpClaudeToken(),
    ]);
    resolveRefresh({ accessToken: "sk-ant-oat-new" });
    await both;

    expect(refreshOAuth2Token).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

describe("ensureFreshAcpClaudeToken: failures", () => {
  test("clears refresh material when the provider rejects the refresh token", async () => {
    expiring = true;
    storedRefreshToken = "revoked";
    refreshImpl = async () => {
      throw new Error("OAuth2 token refresh failed (HTTP 400 invalid_grant)");
    };

    await ensureFreshAcpClaudeToken();

    // Clearing is what flips hasAcpClaudeToken() to "not connected", which is
    // what keeps the Connect card on screen instead of self-dismissing.
    expect(clearAcpClaudeRefreshMaterial).toHaveBeenCalledTimes(1);
    expect(storeAcpClaudeTokens).not.toHaveBeenCalled();
  });

  test("keeps refresh material on a transient failure", async () => {
    expiring = true;
    storedRefreshToken = "refresh-me";
    refreshImpl = async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    };

    await ensureFreshAcpClaudeToken();

    // A network blip must not cost the user their stored credential.
    expect(clearAcpClaudeRefreshMaterial).not.toHaveBeenCalled();
    expect(storeAcpClaudeTokens).not.toHaveBeenCalled();
  });

  test("never throws, so a refresh outage cannot fail the spawn", async () => {
    expiring = true;
    storedRefreshToken = "refresh-me";
    refreshImpl = async () => {
      throw new Error("HTTP 401 unauthorized");
    };

    // Resolves rather than rejects: the stored token may still work, and if it
    // does not, the adapter's auth_required is the path the user recovers by.
    await expect(ensureFreshAcpClaudeToken()).resolves.toBeUndefined();
  });
});
