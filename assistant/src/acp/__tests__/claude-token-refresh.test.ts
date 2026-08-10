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

let spawnCanRead = true;
const isAcpClaudeTokenExpiring = mock(async () => expiring);
const readAcpClaudeRefreshToken = mock(async () => storedRefreshToken);
const persistRefreshedAcpClaudeTokens = mock(async (_tokens: unknown) => {});
const clearAcpClaudeRefreshToken = mock(async () => {});
const acpSpawnCanReadCredential = mock((_field: string) => spawnCanRead);
const refreshOAuth2Token = mock(async (..._args: unknown[]) => refreshImpl());

mock.module("../acp-claude-oauth.js", () => ({
  CLAUDE_OAUTH_CONFIG: {
    tokenExchangeUrl: "https://platform.claude.com/v1/oauth/token",
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    tokenExchangeBodyFormat: "json",
  },
  isAcpClaudeTokenExpiring,
  readAcpClaudeRefreshToken,
  persistRefreshedAcpClaudeTokens,
  clearAcpClaudeRefreshToken,
}));
mock.module("../acp-credential-policy.js", () => ({
  acpSpawnCanReadCredential,
}));
mock.module("../../security/oauth2.js", () => ({ refreshOAuth2Token }));

const { ensureFreshAcpClaudeToken } =
  await import("../claude-token-refresh.js");

beforeEach(() => {
  expiring = false;
  storedRefreshToken = null;
  spawnCanRead = true;
  refreshImpl = async () => {
    throw new Error("refreshOAuth2Token not stubbed for this test");
  };
  isAcpClaudeTokenExpiring.mockClear();
  readAcpClaudeRefreshToken.mockClear();
  persistRefreshedAcpClaudeTokens.mockClear();
  clearAcpClaudeRefreshToken.mockClear();
  acpSpawnCanReadCredential.mockClear();
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
    expect(persistRefreshedAcpClaudeTokens).not.toHaveBeenCalled();
  });

  test("does nothing when expiring with no refresh token stored", async () => {
    // The pre-refresh-token connect. Nothing to spend, so the spawn proceeds
    // and fails at the adapter as auth_required, which raises the Connect card.
    expiring = true;
    storedRefreshToken = null;

    await ensureFreshAcpClaudeToken();

    expect(refreshOAuth2Token).not.toHaveBeenCalled();
    expect(clearAcpClaudeRefreshToken).not.toHaveBeenCalled();
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
    expect(persistRefreshedAcpClaudeTokens).toHaveBeenCalledWith({
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

    // The deferred is built UP FRONT so `resolve` exists before either call
    // runs. Capturing it inside `refreshImpl` instead would leave it unassigned
    // until the first refresh actually starts, several awaits in, and resolving
    // a not-yet-created promise hangs the test rather than failing it.
    let resolveRefresh!: (v: OAuth2TokenResult) => void;
    const gate = new Promise<OAuth2TokenResult>((resolve) => {
      resolveRefresh = resolve;
    });
    refreshImpl = () => gate;

    const both = Promise.all([
      ensureFreshAcpClaudeToken(),
      ensureFreshAcpClaudeToken(),
    ]);
    // Let both calls get past their awaited storage reads and reach the
    // deduplicator before the refresh completes; otherwise the second could
    // start a fresh one and the test would pass or fail on timing.
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
    resolveRefresh({ accessToken: "sk-ant-oat-new" });
    await both;

    expect(refreshOAuth2Token).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

describe("ensureFreshAcpClaudeToken: policy", () => {
  test("does not refresh when the spawn policy denies reading the credential", async () => {
    // The broker would refuse the read this renewal feeds, so spending the
    // refresh token buys nothing. It also keeps a passive spawn from touching
    // a credential the workspace fenced off: the renewal write must never be
    // able to hand `acp_spawn` back a permission an admin removed.
    expiring = true;
    storedRefreshToken = "refresh-me";
    spawnCanRead = false;

    await ensureFreshAcpClaudeToken();

    expect(refreshOAuth2Token).not.toHaveBeenCalled();
    expect(persistRefreshedAcpClaudeTokens).not.toHaveBeenCalled();
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
    expect(clearAcpClaudeRefreshToken).toHaveBeenCalledTimes(1);
    expect(persistRefreshedAcpClaudeTokens).not.toHaveBeenCalled();
  });

  test("keeps refresh material on a transient failure", async () => {
    expiring = true;
    storedRefreshToken = "refresh-me";
    refreshImpl = async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    };

    await ensureFreshAcpClaudeToken();

    // A network blip must not cost the user their stored credential.
    expect(clearAcpClaudeRefreshToken).not.toHaveBeenCalled();
    expect(persistRefreshedAcpClaudeTokens).not.toHaveBeenCalled();
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
