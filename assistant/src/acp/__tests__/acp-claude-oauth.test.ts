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

let storeReturn = true;
const setSecureKeyAsync = mock(
  async (_account: string, _value: string) => storeReturn,
);
const ensureAcpCredentialPolicy = mock(
  (_field: string, _usageDescription: string) => {},
);

mock.module("../../security/secure-keys.js", () => ({ setSecureKeyAsync }));
mock.module("../prepare-agent-env.js", () => ({ ensureAcpCredentialPolicy }));

const {
  CLAUDE_OAUTH_CONFIG,
  CLAUDE_LOOPBACK_CALLBACK_PORT,
  CLAUDE_MANUAL_REDIRECT_URI,
  buildClaudeAuthorizeUrl,
  parseManualClaudeCode,
  storeAcpClaudeToken,
} = await import("../acp-claude-oauth.js");

beforeEach(() => {
  storeReturn = true;
  setSecureKeyAsync.mockClear();
  ensureAcpCredentialPolicy.mockClear();
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

  test("exposes the manual redirect URI and a fixed loopback port", () => {
    expect(CLAUDE_MANUAL_REDIRECT_URI).toBe(
      "https://platform.claude.com/oauth/code/callback",
    );
    expect(typeof CLAUDE_LOOPBACK_CALLBACK_PORT).toBe("number");
    expect(Number.isInteger(CLAUDE_LOOPBACK_CALLBACK_PORT)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildClaudeAuthorizeUrl
// ---------------------------------------------------------------------------

describe("buildClaudeAuthorizeUrl", () => {
  test("produces a URL that parses back to the expected query params", () => {
    const redirectUri = `http://localhost:${CLAUDE_LOOPBACK_CALLBACK_PORT}/callback`;
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
// storeAcpClaudeToken
// ---------------------------------------------------------------------------

describe("storeAcpClaudeToken", () => {
  test("writes the token to credential/acp/claude_oauth_token and provisions the policy", async () => {
    await storeAcpClaudeToken("sk-ant-oat-token");

    expect(setSecureKeyAsync).toHaveBeenCalledTimes(1);
    expect(setSecureKeyAsync).toHaveBeenCalledWith(
      "credential/acp/claude_oauth_token",
      "sk-ant-oat-token",
    );
    expect(ensureAcpCredentialPolicy).toHaveBeenCalledTimes(1);
    expect(ensureAcpCredentialPolicy.mock.calls[0][0]).toBe(
      "claude_oauth_token",
    );
  });

  test("throws when the secure store rejects the write", async () => {
    storeReturn = false;

    await expect(storeAcpClaudeToken("sk-ant-oat-token")).rejects.toThrow(
      /Failed to store/,
    );
    expect(ensureAcpCredentialPolicy).not.toHaveBeenCalled();
  });
});
