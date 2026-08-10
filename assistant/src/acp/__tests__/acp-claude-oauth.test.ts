/**
 * Tests for the Claude OAuth config + capture/store helpers.
 *
 * The store helper reaches into secure-keys and the ACP credential policy, so
 * we mock both (wired BEFORE importing the module under test via dynamic
 * import) and assert the vault write targets `credential/acp/claude_oauth_token`
 * and throws when the backend rejects the write.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — wired BEFORE importing the module via dynamic import.
// ---------------------------------------------------------------------------

/**
 * Key-addressed fake vault. The module now touches THREE keys (access token,
 * refresh token, expiry), so a single shared return value would let a test
 * pass for the wrong reason: an expiry read that accidentally returns the
 * access token parses to NaN and silently reads as "no expiry recorded".
 */
const vault = new Map<string, string>();
const ACCESS_KEY = "credential/acp/claude_oauth_token";
const REFRESH_KEY = "credential/acp/claude_oauth_refresh_token";
const EXPIRES_KEY = "credential/acp/claude_oauth_expires_at";

let storeReturn = true;
const setSecureKeyAsync = mock(async (account: string, value: string) => {
  if (storeReturn) {
    vault.set(account, value);
  }
  return storeReturn;
});
const getSecureKeyAsync = mock(async (account: string) => vault.get(account));
const deleteSecureKeyAsync = mock(async (account: string) =>
  vault.delete(account),
);
const grantAcpSpawnPolicy = mock(
  (_field: string, _usageDescription: string) => {},
);
let spawnCanRead = true;
const acpSpawnCanReadCredential = mock((_field: string) => spawnCanRead);

mock.module("../../security/secure-keys.js", () => ({
  setSecureKeyAsync,
  getSecureKeyAsync,
  deleteSecureKeyAsync,
}));
mock.module("../acp-credential-policy.js", () => ({
  grantAcpSpawnPolicy,
  acpSpawnCanReadCredential,
}));

const {
  CLAUDE_OAUTH_CONFIG,
  CLAUDE_MANUAL_REDIRECT_URI,
  buildClaudeAuthorizeUrl,
  parseManualClaudeCode,
  storeConnectedAcpClaudeTokens,
  persistRefreshedAcpClaudeTokens,
  hasAcpClaudeToken,
  isAcpClaudeTokenExpiring,
  readAcpClaudeRefreshToken,
  clearAcpClaudeRefreshToken,
  forgetAcpClaudeRenewalStateOnForeignWrite,
} = await import("../acp-claude-oauth.js");

beforeEach(() => {
  vault.clear();
  storeReturn = true;
  spawnCanRead = true;
  setSecureKeyAsync.mockClear();
  getSecureKeyAsync.mockClear();
  deleteSecureKeyAsync.mockClear();
  grantAcpSpawnPolicy.mockClear();
  acpSpawnCanReadCredential.mockClear();
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("CLAUDE_OAUTH_CONFIG", () => {
  test("matches the verified endpoints, client id, and scope", () => {
    expect(CLAUDE_OAUTH_CONFIG.authorizeUrl).toBe(
      "https://claude.ai/oauth/authorize",
    );
    expect(CLAUDE_OAUTH_CONFIG.tokenExchangeUrl).toBe(
      "https://platform.claude.com/v1/oauth/token",
    );
    expect(CLAUDE_OAUTH_CONFIG.clientId).toBe(
      "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    );
    expect(CLAUDE_OAUTH_CONFIG.scopes).toEqual(["user:inference"]);
    expect(CLAUDE_OAUTH_CONFIG.scopeSeparator).toBe(" ");
  });

  test("exposes the manual redirect URI", () => {
    expect(CLAUDE_MANUAL_REDIRECT_URI).toBe(
      "https://platform.claude.com/oauth/code/callback",
    );
  });
});

// ---------------------------------------------------------------------------
// buildClaudeAuthorizeUrl
// ---------------------------------------------------------------------------

describe("buildClaudeAuthorizeUrl", () => {
  test("produces a URL that parses back to the expected query params", () => {
    const redirectUri = "http://localhost:54545/callback";
    const url = buildClaudeAuthorizeUrl(redirectUri, {
      codeChallenge: "challenge-123",
      state: "state-abc",
    });

    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(
      "https://claude.ai/oauth/authorize",
    );

    const params = parsed.searchParams;
    expect(params.get("response_type")).toBe("code");
    expect(params.get("client_id")).toBe(
      "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    );
    expect(params.get("redirect_uri")).toBe(redirectUri);
    expect(params.get("scope")).toBe("user:inference");
    expect(params.get("state")).toBe("state-abc");
    expect(params.get("code_challenge")).toBe("challenge-123");
    expect(params.get("code_challenge_method")).toBe("S256");
  });

  test("works with the manual redirect URI too", () => {
    const url = buildClaudeAuthorizeUrl(CLAUDE_MANUAL_REDIRECT_URI, {
      codeChallenge: "c",
      state: "s",
    });
    expect(new URL(url).searchParams.get("redirect_uri")).toBe(
      CLAUDE_MANUAL_REDIRECT_URI,
    );
  });
});

// ---------------------------------------------------------------------------
// parseManualClaudeCode
// ---------------------------------------------------------------------------

describe("parseManualClaudeCode", () => {
  test("round-trips `code#state`", () => {
    expect(parseManualClaudeCode("abc#xyz")).toEqual({
      code: "abc",
      state: "xyz",
    });
  });

  test("throws on input missing the `#` separator", () => {
    expect(() => parseManualClaudeCode("nohash")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// storeAcpClaudeTokens
// ---------------------------------------------------------------------------

describe("storeConnectedAcpClaudeTokens", () => {
  test("writes the access token and force-grants the acp_spawn policy (repairs a denied policy)", async () => {
    await storeConnectedAcpClaudeTokens({ accessToken: "sk-ant-oat-token" });

    expect(setSecureKeyAsync).toHaveBeenCalledWith(
      ACCESS_KEY,
      "sk-ant-oat-token",
    );
    // grant (union), not merely ensure (preserve), so an explicit Connect
    // repairs a credential whose allowedTools omitted acp_spawn.
    expect(grantAcpSpawnPolicy).toHaveBeenCalledTimes(1);
    expect(grantAcpSpawnPolicy.mock.calls[0][0]).toBe("claude_oauth_token");
  });

  test("persists the refresh token and an absolute expiry alongside it", async () => {
    const before = Date.now();
    await storeConnectedAcpClaudeTokens({
      accessToken: "sk-ant-oat-token",
      refreshToken: "refresh-me",
      expiresIn: 3600,
    });

    expect(vault.get(REFRESH_KEY)).toBe("refresh-me");
    const expiresAt = Number(vault.get(EXPIRES_KEY));
    // Absolute epoch ms roughly one hour out, not the raw `expires_in`.
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(expiresAt).toBeLessThan(before + 3600 * 1000 + 5000);
  });

  test("clears stale refresh material when a reconnect returns none", async () => {
    vault.set(REFRESH_KEY, "old-refresh");
    vault.set(EXPIRES_KEY, String(Date.now() + 60_000));

    await storeConnectedAcpClaudeTokens({ accessToken: "sk-ant-oat-fresh" });

    // Leaving the old values would pair a NEW access token with the PREVIOUS
    // connect's refresh token, which renews into the wrong credential.
    expect(vault.has(REFRESH_KEY)).toBe(false);
    expect(vault.has(EXPIRES_KEY)).toBe(false);
  });

  test("throws when the secure store rejects the write", async () => {
    storeReturn = false;

    await expect(
      storeConnectedAcpClaudeTokens({ accessToken: "sk-ant-oat-token" }),
    ).rejects.toThrow(/Failed to store/);
    expect(grantAcpSpawnPolicy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Refresh material accessors
// ---------------------------------------------------------------------------

describe("refresh material accessors", () => {
  test("isAcpClaudeTokenExpiring is false when no expiry was recorded", async () => {
    vault.set(ACCESS_KEY, "sk-ant-oat-token");
    // Tokens connected before expiry tracking existed must not be treated as
    // expired, or we would discard a working credential.
    expect(await isAcpClaudeTokenExpiring()).toBe(false);
  });

  test("isAcpClaudeTokenExpiring is true once the recorded expiry has passed", async () => {
    vault.set(EXPIRES_KEY, String(Date.now() - 1000));
    expect(await isAcpClaudeTokenExpiring()).toBe(true);
  });

  test("isAcpClaudeTokenExpiring ignores an unparseable expiry", async () => {
    vault.set(EXPIRES_KEY, "not-a-number");
    expect(await isAcpClaudeTokenExpiring()).toBe(false);
  });

  test("clearAcpClaudeRefreshToken leaves the account reading as NOT connected", async () => {
    vault.set(ACCESS_KEY, "sk-ant-oat-token");
    vault.set(REFRESH_KEY, "refresh-me");
    vault.set(EXPIRES_KEY, String(Date.now() - 1000));

    await clearAcpClaudeRefreshToken();

    // The invariant, not the mechanics: after a rejected refresh the account
    // must stop vouching for itself, or the Connect card self-dismisses and
    // the user is stuck. Asserting only that the expiry survives would pass
    // just as well against a helper that cleared it and broke this.
    expect(await hasAcpClaudeToken()).toBe(false);
    expect(await readAcpClaudeRefreshToken()).toBeNull();
    // The expiry is what makes that answer possible, so it must survive.
    expect(vault.get(EXPIRES_KEY)).toBeDefined();
    expect(vault.get(ACCESS_KEY)).toBe("sk-ant-oat-token");
  });
});

// ---------------------------------------------------------------------------
// Writes that bypass the Connect flow
// ---------------------------------------------------------------------------

describe("forgetAcpClaudeRenewalStateOnForeignWrite", () => {
  test("a hand-provisioned token reads as connected instead of inheriting a stale expiry", async () => {
    // `credentials set` and friends write only the access token. The previous
    // token's expiry would otherwise condemn a brand-new working one.
    vault.set(EXPIRES_KEY, String(Date.now() - 1000));
    vault.set(ACCESS_KEY, "sk-ant-oat-pasted");

    await forgetAcpClaudeRenewalStateOnForeignWrite(
      "acp",
      "claude_oauth_token",
    );

    expect(await hasAcpClaudeToken()).toBe(true);
    expect(vault.has(EXPIRES_KEY)).toBe(false);
  });

  test("drops the previous refresh token so it cannot overwrite the new one", async () => {
    // Left in place, the next expiring spawn would spend this and clobber the
    // token the user just pasted.
    vault.set(ACCESS_KEY, "sk-ant-oat-pasted");
    vault.set(REFRESH_KEY, "refresh-from-previous-connect");
    vault.set(EXPIRES_KEY, String(Date.now() - 1000));

    await forgetAcpClaudeRenewalStateOnForeignWrite(
      "acp",
      "claude_oauth_token",
    );

    expect(await readAcpClaudeRefreshToken()).toBeNull();
  });

  test("ignores other services and fields", async () => {
    vault.set(REFRESH_KEY, "refresh-me");

    await forgetAcpClaudeRenewalStateOnForeignWrite("acp", "openai_api_key");
    await forgetAcpClaudeRenewalStateOnForeignWrite("github", "token");

    expect(vault.get(REFRESH_KEY)).toBe("refresh-me");
  });
});

// ---------------------------------------------------------------------------
// persistRefreshedAcpClaudeTokens
// ---------------------------------------------------------------------------

describe("persistRefreshedAcpClaudeTokens", () => {
  test("writes the token set WITHOUT granting the acp_spawn policy", async () => {
    await persistRefreshedAcpClaudeTokens({
      accessToken: "sk-ant-oat-renewed",
      refreshToken: "refresh-rotated",
      expiresIn: 3600,
    });

    expect(vault.get(ACCESS_KEY)).toBe("sk-ant-oat-renewed");
    expect(vault.get(REFRESH_KEY)).toBe("refresh-rotated");
    // A background renewal carries no user consent, so it must not restore a
    // permission an admin removed from allowedTools.
    expect(grantAcpSpawnPolicy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// hasAcpClaudeToken
// ---------------------------------------------------------------------------

describe("hasAcpClaudeToken", () => {
  test("reads credential/acp/claude_oauth_token and reports true when present", async () => {
    vault.set(ACCESS_KEY, "sk-ant-oat-token");

    expect(await hasAcpClaudeToken()).toBe(true);
    expect(getSecureKeyAsync).toHaveBeenCalledWith(ACCESS_KEY);
  });

  test("reports false when the vault field is absent", async () => {
    expect(await hasAcpClaudeToken()).toBe(false);
  });

  test("reports false for an empty stored value", async () => {
    vault.set(ACCESS_KEY, "");
    expect(await hasAcpClaudeToken()).toBe(false);
  });

  test("reports false for a legacy Anthropic API key so Connect stays offered", async () => {
    vault.set(ACCESS_KEY, "sk-ant-api03-legacy-bad-entry");
    expect(await hasAcpClaudeToken()).toBe(false);
  });

  test("reports false when the spawn policy can't read the token (denied allowedTools)", async () => {
    // A valid OAuth token is stored, but an explicit `allowedTools` that omits
    // `acp_spawn` means the broker denies the spawn read. Reporting "connected"
    // would self-dismiss the card and trap the user in a missing-token loop, so
    // it stays not-connected to keep the repair CTA visible.
    vault.set(ACCESS_KEY, "sk-ant-oat-token");
    spawnCanRead = false;
    expect(await hasAcpClaudeToken()).toBe(false);
  });

  test("reports FALSE for an expired token with no refresh token", async () => {
    // The regression this guards: presence alone used to answer "connected",
    // so an expired credential reported true and the inline Connect card
    // self-dismissed on mount, leaving a failed run with no way to act on it.
    vault.set(ACCESS_KEY, "sk-ant-oat-token");
    vault.set(EXPIRES_KEY, String(Date.now() - 1000));

    expect(await hasAcpClaudeToken()).toBe(false);
  });

  test("reports true for an expired token that still has a refresh token", async () => {
    // Renewable on the next spawn, so there is nothing for the user to do and
    // no card to show.
    vault.set(ACCESS_KEY, "sk-ant-oat-token");
    vault.set(EXPIRES_KEY, String(Date.now() - 1000));
    vault.set(REFRESH_KEY, "refresh-me");

    expect(await hasAcpClaudeToken()).toBe(true);
  });

  test("reports true for an unexpired token with no refresh token", async () => {
    // No refresh token is not itself a problem while the access token is live.
    vault.set(ACCESS_KEY, "sk-ant-oat-token");
    vault.set(EXPIRES_KEY, String(Date.now() + 60 * 60 * 1000));

    expect(await hasAcpClaudeToken()).toBe(true);
  });
});
