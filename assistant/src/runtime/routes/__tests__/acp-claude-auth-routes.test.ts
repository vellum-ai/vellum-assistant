/**
 * Tests for the local (loopback) Connect Claude OAuth routes.
 *
 * `start` binds a real loopback via the oauth2 layer (default, un-mocked) so we
 * assert it produces a genuine Claude authorize URL with a localhost `/callback`
 * redirect and registers pending state. The capture/exchange/store path is
 * driven by overriding `prepareOAuth2Flow` with a controllable completion so we
 * can flip it to resolved (connected) or rejected (error) without real network.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { OAuth2FlowResult } from "../../../security/oauth2.js";

// ---------------------------------------------------------------------------
// Mocks — wired BEFORE importing the module under test.
// ---------------------------------------------------------------------------

const actualOauth2 = await import("../../../security/oauth2.js");
// Default implementation delegates to the real loopback flow; individual tests
// override it with `mockImplementationOnce` to inject a controllable completion.
const prepareOAuth2FlowMock = mock(actualOauth2.prepareOAuth2Flow);
mock.module("../../../security/oauth2.js", () => ({
  ...actualOauth2,
  prepareOAuth2Flow: prepareOAuth2FlowMock,
}));

const actualClaudeOauth = await import("../../../acp/acp-claude-oauth.js");
const storeAcpClaudeTokenMock = mock(async (_token: string) => {});
mock.module("../../../acp/acp-claude-oauth.js", () => ({
  ...actualClaudeOauth,
  storeAcpClaudeToken: storeAcpClaudeTokenMock,
}));

const actualSecureKeys = await import("../../../security/secure-keys.js");
const setSecureKeyAsyncMock = mock(
  async (_key: string, _value: string) => true,
);
mock.module("../../../security/secure-keys.js", () => ({
  ...actualSecureKeys,
  setSecureKeyAsync: setSecureKeyAsyncMock,
}));

const { ROUTES } = await import("../acp-claude-auth-routes.js");

const startHandler = ROUTES.find(
  (r) => r.operationId === "acp_claude_auth_start",
)!.handler;
const statusHandler = ROUTES.find(
  (r) => r.operationId === "acp_claude_auth_status",
)!.handler;

const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

interface StartResult {
  authorize_url: string;
  state: string;
}
interface StatusResult {
  status: "pending" | "connected" | "error";
  error?: string;
}

function getStatus(state: string): StatusResult {
  return statusHandler({ pathParams: { state } }) as StatusResult;
}

/** Poll the status handler until it reaches `target` (or give up). */
async function waitForStatus(
  state: string,
  target: StatusResult["status"],
): Promise<StatusResult> {
  for (let i = 0; i < 40; i++) {
    const status = getStatus(state);
    if (status.status === target) return status;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`status for ${state} never reached ${target}`);
}

/** Build a controllable `prepareOAuth2Flow` result for one start call. */
function deferredFlow(state: string): {
  resolve: (r: OAuth2FlowResult) => void;
  reject: (e: Error) => void;
} {
  let resolve!: (r: OAuth2FlowResult) => void;
  let reject!: (e: Error) => void;
  const completion = new Promise<OAuth2FlowResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  prepareOAuth2FlowMock.mockImplementationOnce(async () => ({
    authorizeUrl: `https://claude.ai/oauth/authorize?state=${state}`,
    state,
    completion,
  }));
  return { resolve, reject };
}

beforeEach(() => {
  prepareOAuth2FlowMock.mockClear();
  storeAcpClaudeTokenMock.mockClear();
  setSecureKeyAsyncMock.mockClear();
});

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

describe("acp_claude_auth_start", () => {
  test("returns a well-formed Claude authorize URL with a localhost /callback redirect and registers pending state", async () => {
    // Uses the real prepareOAuth2Flow (binds an ephemeral loopback port).
    const result = (await startHandler({})) as StartResult;

    const url = new URL(result.authorize_url);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://claude.ai/oauth/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe(CLAUDE_CLIENT_ID);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");

    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    expect(redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/);

    expect(result.state).toBeTruthy();
    expect(url.searchParams.get("state")).toBe(result.state);

    // The flow is now tracked as pending.
    expect(getStatus(result.state)).toEqual({ status: "pending" });
  });
});

// ---------------------------------------------------------------------------
// capture -> connected
// ---------------------------------------------------------------------------

describe("loopback capture", () => {
  test("stores the token and flips status pending -> connected", async () => {
    const state = "connect-state-1";
    const flow = deferredFlow(state);

    const result = (await startHandler({})) as StartResult;
    expect(result.state).toBe(state);
    // Before the redirect is captured, the flow is pending.
    expect(getStatus(state).status).toBe("pending");

    flow.resolve({
      tokens: {
        accessToken: "sk-ant-oat-access",
        refreshToken: "refresh-xyz",
        expiresIn: 3600,
      },
      grantedScopes: ["user:inference"],
      rawTokenResponse: {},
    });

    const status = await waitForStatus(state, "connected");
    expect(status).toEqual({ status: "connected" });

    // Access token persisted via storeAcpClaudeToken.
    expect(storeAcpClaudeTokenMock).toHaveBeenCalledTimes(1);
    expect(storeAcpClaudeTokenMock).toHaveBeenCalledWith("sk-ant-oat-access");

    // Refresh token + expiry persisted under the ACP service keys.
    expect(setSecureKeyAsyncMock).toHaveBeenCalledWith(
      "credential/acp/claude_oauth_refresh_token",
      "refresh-xyz",
    );
    const expiresCall = setSecureKeyAsyncMock.mock.calls.find(
      (c) => c[0] === "credential/acp/claude_oauth_expires_at",
    );
    expect(expiresCall).toBeDefined();
  });

  test("flips status to error when the exchange fails", async () => {
    const state = "connect-state-2";
    const flow = deferredFlow(state);

    await startHandler({});
    flow.reject(new Error("token exchange failed"));

    const status = await waitForStatus(state, "error");
    expect(status.status).toBe("error");
    expect(status.error).toContain("token exchange failed");
    expect(storeAcpClaudeTokenMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe("acp_claude_auth_status", () => {
  test("unknown state yields a 404 error, not a 500", () => {
    let thrown: { statusCode?: number } | undefined;
    try {
      getStatus("no-such-state");
    } catch (err) {
      thrown = err as { statusCode?: number };
    }
    expect(thrown).toBeDefined();
    expect(thrown!.statusCode).toBe(404);
  });
});
