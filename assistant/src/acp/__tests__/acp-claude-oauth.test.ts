/**
 * Tests for the Claude OAuth config + capture/store helpers.
 *
 * The store helper reaches into secure-keys, so we mock that (wired BEFORE
 * importing the module under test via dynamic import) and assert the vault
 * write targets `credential/acp/claude_oauth_token` and throws when the backend
 * rejects the write.
 *
 * The ACP credential policy is NOT mocked: `hasAcpClaudeToken` has to answer
 * exactly what the spawn-time broker read would, so it is exercised against the
 * real metadata store (pointed at a temp dir) and the real policy evaluation.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — wired BEFORE importing the module via dynamic import.
// ---------------------------------------------------------------------------

let storeReturn = true;
let getReturn: string | undefined = undefined;
const setSecureKeyAsync = mock(
  async (_account: string, _value: string) => storeReturn,
);
const getSecureKeyAsync = mock(async (_account: string) => getReturn);

mock.module("../../security/secure-keys.js", () => ({
  setSecureKeyAsync,
  getSecureKeyAsync,
}));

const { _setMetadataPath, getCredentialMetadata, upsertCredentialMetadata } =
  await import("../../tools/credentials/metadata-store.js");

const { acpSpawnCredentialDenialReason } =
  await import("../prepare-agent-env.js");

const {
  CLAUDE_OAUTH_CONFIG,
  CLAUDE_MANUAL_REDIRECT_URI,
  buildClaudeAuthorizeUrl,
  parseManualClaudeCode,
  storeAcpClaudeToken,
  hasAcpClaudeToken,
} = await import("../acp-claude-oauth.js");

const ACP_SERVICE = "acp";
const OAUTH_FIELD = "claude_oauth_token";
const ACP_SPAWN_TOOL = "acp_spawn";

const TEST_DIR = join(
  tmpdir(),
  `vellum-acp-claude-oauth-test-${randomBytes(4).toString("hex")}`,
);

function oauthMetadata() {
  return getCredentialMetadata(ACP_SERVICE, OAUTH_FIELD);
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  _setMetadataPath(join(TEST_DIR, "metadata.json"));
  storeReturn = true;
  getReturn = undefined;
  setSecureKeyAsync.mockClear();
  getSecureKeyAsync.mockClear();
});

afterEach(() => {
  _setMetadataPath(null);
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("CLAUDE_OAUTH_CONFIG", () => {
  test("matches the verified endpoints, client id, and scope", () => {
    // The single literal pin for the endpoint. Every other test asserts
    // against CLAUDE_OAUTH_CONFIG.authorizeUrl, so an endpoint change edits
    // exactly this one value.
    expect(CLAUDE_OAUTH_CONFIG.authorizeUrl).toBe(
      "https://claude.com/cai/oauth/authorize",
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
    // The property under test is that the builder uses the configured
    // endpoint; the value itself is guarded by the literal pin above.
    expect(`${parsed.origin}${parsed.pathname}`).toBe(
      CLAUDE_OAUTH_CONFIG.authorizeUrl,
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
    // The manual flow's defining param: tells Claude to render `code#state`
    // on the callback page. Claude rejects a manual-redirect grant without it.
    expect(params.get("code")).toBe("true");
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
  test("writes the token to the acp/claude_oauth_token vault field", async () => {
    await storeAcpClaudeToken("sk-ant-oat-token");

    expect(setSecureKeyAsync).toHaveBeenCalledTimes(1);
    expect(setSecureKeyAsync).toHaveBeenCalledWith(
      "credential/acp/claude_oauth_token",
      "sk-ant-oat-token",
    );
  });

  test("takes a domain-restricted credential from not-connected to connected", async () => {
    // Invariant: when the vault holds a usable token whose domain policy
    // makes the spawn read fail, the status check keeps the Connect card
    // offered, and completing Connect repairs the policy so the retry after
    // a successful sign-in succeeds. The per-shape repair details are covered
    // by the repairAcpSpawnPolicy suite in prepare-agent-env.test.ts.
    upsertCredentialMetadata(ACP_SERVICE, OAUTH_FIELD, {
      allowedTools: [ACP_SPAWN_TOOL],
      allowedDomains: ["api.anthropic.com"],
    });
    getReturn = "sk-ant-oat-token";
    expect(await hasAcpClaudeToken()).toBe(false);

    await storeAcpClaudeToken("sk-ant-oat-token");

    expect(await hasAcpClaudeToken()).toBe(true);
    expect(acpSpawnCredentialDenialReason(OAUTH_FIELD)).toBeUndefined();
  });

  test("throws when the secure store rejects the write", async () => {
    storeReturn = false;

    await expect(storeAcpClaudeToken("sk-ant-oat-token")).rejects.toThrow(
      /Failed to store/,
    );
    expect(oauthMetadata()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// hasAcpClaudeToken
// ---------------------------------------------------------------------------

describe("hasAcpClaudeToken", () => {
  test("reads credential/acp/claude_oauth_token and reports true when present", async () => {
    getReturn = "sk-ant-oat-token";

    expect(await hasAcpClaudeToken()).toBe(true);
    expect(getSecureKeyAsync).toHaveBeenCalledWith(
      "credential/acp/claude_oauth_token",
    );
  });

  test("reports false when the vault field is absent", async () => {
    getReturn = undefined;
    expect(await hasAcpClaudeToken()).toBe(false);
  });

  test("reports false for an empty stored value", async () => {
    getReturn = "";
    expect(await hasAcpClaudeToken()).toBe(false);
  });

  test("reports false for a legacy Anthropic API key so Connect stays offered", async () => {
    getReturn = "sk-ant-api03-legacy-bad-entry";
    expect(await hasAcpClaudeToken()).toBe(false);
  });

  test("reports true for metadata with an empty allowedTools (the spawn would grant acp_spawn)", async () => {
    // One allow-state case: the full policy matrix is guarded by the parity
    // suite in prepare-agent-env.test.ts and the tool-policy unit tests.
    upsertCredentialMetadata(ACP_SERVICE, OAUTH_FIELD, { allowedTools: [] });
    getReturn = "sk-ant-oat-token";

    expect(await hasAcpClaudeToken()).toBe(true);
  });

  test("reports false for a domain-restricted credential the broker refuses server-side", async () => {
    // acp_spawn is allowed, but a non-empty allowedDomains scopes the credential
    // to browser fills, so every spawn read is denied. The status check has to
    // see that too, otherwise the Connect card self-dismisses while acp_spawn
    // keeps failing with the missing-token marker.
    upsertCredentialMetadata(ACP_SERVICE, OAUTH_FIELD, {
      allowedTools: [ACP_SPAWN_TOOL],
      allowedDomains: ["api.anthropic.com"],
    });
    getReturn = "sk-ant-oat-token";

    expect(await hasAcpClaudeToken()).toBe(false);
  });

  test("writes nothing to the metadata store (the status route is a GET)", async () => {
    upsertCredentialMetadata(ACP_SERVICE, OAUTH_FIELD, { allowedTools: [] });
    getReturn = "sk-ant-oat-token";
    const before = oauthMetadata();

    await hasAcpClaudeToken();

    expect(oauthMetadata()).toEqual(before);
  });

  test("creates no metadata when there is none to begin with", async () => {
    getReturn = "sk-ant-oat-token";

    await hasAcpClaudeToken();

    expect(oauthMetadata()).toBeUndefined();
  });
});
