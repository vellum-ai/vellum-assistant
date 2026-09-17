/**
 * Tests for the Claude ACP OAuth renewal policy.
 *
 * Storage is mocked (it belongs to `acp-claude-oauth.ts`, tested separately) so
 * these assert only the decisions this module owns: when to spend the refresh
 * token, what to persist, and what to tear down when the provider rejects it.
 *
 * `isCredentialError` is deliberately not mocked. Whether a failure is
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
let storedAccessToken = true;
let storedRefreshToken: string | null = null;
let refreshImpl: () => Promise<OAuth2TokenResult> = async () => {
  throw new Error("refreshOAuth2Token not stubbed for this test");
};

let spawnDenial: string | undefined = undefined;
const isAcpClaudeTokenExpiring = mock(async () => expiring);
const hasStoredAcpClaudeAccessToken = mock(async () => storedAccessToken);
const forgetAcpClaudeRenewalStateIfUnbound = mock(async () => {});
const readAcpClaudeRefreshToken = mock(async () => storedRefreshToken);
const persistRefreshedAcpClaudeTokens = mock(
  async (_tokens: unknown, _expectedRefreshToken: string) => true,
);
const clearAcpClaudeRefreshToken = mock(async () => {});
const acpSpawnCredentialDenialReason = mock((_field: string) => spawnDenial);
const refreshOAuth2Token = mock(async (..._args: unknown[]) => refreshImpl());

mock.module("../acp-claude-oauth.js", () => ({
  CLAUDE_OAUTH_CONFIG: {
    tokenExchangeUrl: "https://platform.claude.com/v1/oauth/token",
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    tokenExchangeBodyFormat: "json",
  },
  isAcpClaudeTokenExpiring,
  hasStoredAcpClaudeAccessToken,
  forgetAcpClaudeRenewalStateIfUnbound,
  readAcpClaudeRefreshToken,
  persistRefreshedAcpClaudeTokens,
  clearAcpClaudeRefreshToken,
}));
mock.module("../prepare-agent-env.js", () => ({
  acpSpawnCredentialDenialReason,
}));
mock.module("../../security/oauth2.js", () => ({ refreshOAuth2Token }));

const { ensureFreshAcpClaudeToken } =
  await import("../claude-token-refresh.js");

beforeEach(() => {
  expiring = false;
  storedAccessToken = true;
  storedRefreshToken = null;
  spawnDenial = undefined;
  refreshImpl = async () => {
    throw new Error("refreshOAuth2Token not stubbed for this test");
  };
  isAcpClaudeTokenExpiring.mockClear();
  hasStoredAcpClaudeAccessToken.mockClear();
  forgetAcpClaudeRenewalStateIfUnbound.mockClear();
  readAcpClaudeRefreshToken.mockClear();
  persistRefreshedAcpClaudeTokens.mockClear();
  clearAcpClaudeRefreshToken.mockClear();
  acpSpawnCredentialDenialReason.mockClear();
  refreshOAuth2Token.mockClear();
});

describe("ensureFreshAcpClaudeToken: skip paths", () => {
  test("does nothing while the token is still fresh", async () => {
    expiring = false;
    storedRefreshToken = "refresh-me";

    await ensureFreshAcpClaudeToken();

    expect(refreshOAuth2Token).not.toHaveBeenCalled();
    expect(persistRefreshedAcpClaudeTokens).not.toHaveBeenCalled();
  });

  test("does nothing when expiring with no refresh token stored", async () => {
    expiring = true;
    storedRefreshToken = null;

    await ensureFreshAcpClaudeToken();

    expect(refreshOAuth2Token).not.toHaveBeenCalled();
    expect(clearAcpClaudeRefreshToken).not.toHaveBeenCalled();
  });

  test("drops unbound leftover refresh material before deciding to renew", async () => {
    expiring = false;
    storedAccessToken = true;

    await ensureFreshAcpClaudeToken();

    expect(forgetAcpClaudeRenewalStateIfUnbound).toHaveBeenCalledTimes(1);
    expect(refreshOAuth2Token).not.toHaveBeenCalled();
  });

  test("does not mint a new access token after the stored one was deleted", async () => {
    expiring = true;
    storedAccessToken = false;
    storedRefreshToken = "refresh-leftover";

    await ensureFreshAcpClaudeToken();

    expect(refreshOAuth2Token).not.toHaveBeenCalled();
    expect(persistRefreshedAcpClaudeTokens).not.toHaveBeenCalled();
    expect(clearAcpClaudeRefreshToken).not.toHaveBeenCalled();
  });
});

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
    expect(args[3]).toBeUndefined();
    expect(args[5]).toBe("json");

    expect(persistRefreshedAcpClaudeTokens).toHaveBeenCalledWith(
      {
        accessToken: "sk-ant-oat-new",
        refreshToken: "refresh-rotated",
        expiresIn: 3600,
      },
      "refresh-me",
    );
  });

  test("does not treat a skipped stale persist as a failure", async () => {
    expiring = true;
    storedRefreshToken = "refresh-me";
    persistRefreshedAcpClaudeTokens.mockResolvedValueOnce(false);
    refreshImpl = async () => ({
      accessToken: "sk-ant-oat-stale",
      refreshToken: "refresh-rotated",
      expiresIn: 3600,
    });

    await expect(ensureFreshAcpClaudeToken()).resolves.toBeUndefined();
    expect(clearAcpClaudeRefreshToken).not.toHaveBeenCalled();
  });

  test("runs one refresh for concurrent spawns", async () => {
    expiring = true;
    storedRefreshToken = "refresh-me";

    let resolveRefresh!: (v: OAuth2TokenResult) => void;
    const gate = new Promise<OAuth2TokenResult>((resolve) => {
      resolveRefresh = resolve;
    });
    refreshImpl = () => gate;

    const both = Promise.all([
      ensureFreshAcpClaudeToken(),
      ensureFreshAcpClaudeToken(),
    ]);
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
    resolveRefresh({ accessToken: "sk-ant-oat-new" });
    await both;

    expect(refreshOAuth2Token).toHaveBeenCalledTimes(1);
  });
});

describe("ensureFreshAcpClaudeToken: policy", () => {
  test("does not refresh when the spawn policy denies reading the credential", async () => {
    expiring = true;
    storedRefreshToken = "refresh-me";
    spawnDenial = 'Tool "acp_spawn" is not allowed to use this credential';

    await ensureFreshAcpClaudeToken();

    expect(refreshOAuth2Token).not.toHaveBeenCalled();
    expect(persistRefreshedAcpClaudeTokens).not.toHaveBeenCalled();
  });
});

describe("ensureFreshAcpClaudeToken: failures", () => {
  test("clears refresh material when the provider rejects the refresh token", async () => {
    expiring = true;
    storedRefreshToken = "revoked";
    refreshImpl = async () => {
      throw new Error("OAuth2 token refresh failed (HTTP 400 invalid_grant)");
    };

    await ensureFreshAcpClaudeToken();

    expect(clearAcpClaudeRefreshToken).toHaveBeenCalledWith("revoked");
    expect(persistRefreshedAcpClaudeTokens).not.toHaveBeenCalled();
  });

  test("clears refresh material when the refresh succeeds with no access token", async () => {
    expiring = true;
    storedRefreshToken = "refresh-me";
    refreshImpl = async () =>
      ({
        accessToken: "",
        refreshToken: "refresh-rotated",
        expiresIn: 3600,
      }) as OAuth2TokenResult;

    await ensureFreshAcpClaudeToken();

    expect(clearAcpClaudeRefreshToken).toHaveBeenCalledWith("refresh-me");
    expect(persistRefreshedAcpClaudeTokens).not.toHaveBeenCalled();
  });

  test("keeps refresh material on a transient failure", async () => {
    expiring = true;
    storedRefreshToken = "refresh-me";
    refreshImpl = async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    };

    await ensureFreshAcpClaudeToken();

    expect(clearAcpClaudeRefreshToken).not.toHaveBeenCalled();
    expect(persistRefreshedAcpClaudeTokens).not.toHaveBeenCalled();
  });

  test("never throws, so a refresh outage cannot fail the spawn", async () => {
    expiring = true;
    storedRefreshToken = "refresh-me";
    refreshImpl = async () => {
      throw new Error("HTTP 401 unauthorized");
    };

    await expect(ensureFreshAcpClaudeToken()).resolves.toBeUndefined();
  });
});
