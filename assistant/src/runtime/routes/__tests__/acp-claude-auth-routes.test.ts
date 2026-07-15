/**
 * Tests for the Connect Claude OAuth routes.
 *
 * The local (loopback) path: `start` binds a real loopback via the oauth2 layer
 * (default, un-mocked) so we assert it produces a genuine Claude authorize URL
 * with a localhost `/callback` redirect and registers pending state. The
 * capture/exchange/store path is driven by overriding `prepareOAuth2Flow` with a
 * controllable completion so we can flip it to resolved (connected) or rejected
 * (error) without real network.
 *
 * The cloud (manual) path: with `getIsContainerized()` mocked true + the flag on,
 * `start` returns `mode: "manual"` with the manual redirect URI, and `exchange`
 * stores the token from a pasted `code#state` (or a raw code + state). With the
 * flag off it fails closed. `exchangeCodeForTokens` is mocked so no real network
 * is hit.
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
// The manual path exchanges the pasted code directly; mock it so no network is
// hit and assert the args the handler passes.
const exchangeCodeForTokensMock = mock(
  async (): Promise<OAuth2FlowResult> => ({
    tokens: {
      accessToken: "sk-ant-oat-manual",
      refreshToken: "refresh-manual",
      expiresIn: 3600,
    },
    grantedScopes: ["user:inference"],
    rawTokenResponse: {},
  }),
);
mock.module("../../../security/oauth2.js", () => ({
  ...actualOauth2,
  prepareOAuth2Flow: prepareOAuth2FlowMock,
  exchangeCodeForTokens: exchangeCodeForTokensMock,
}));

const actualClaudeOauth = await import("../../../acp/acp-claude-oauth.js");
const { CLAUDE_MANUAL_REDIRECT_URI } = actualClaudeOauth;
const storeAcpClaudeTokenMock = mock(async (_token: string) => {});
mock.module("../../../acp/acp-claude-oauth.js", () => ({
  ...actualClaudeOauth,
  storeAcpClaudeToken: storeAcpClaudeTokenMock,
}));

// Host detection: default false (local/loopback) so the PR-5 tests are
// unaffected; the cloud tests flip it to true.
const actualEnvRegistry = await import("../../../config/env-registry.js");
const getIsContainerizedMock = mock(() => false);
mock.module("../../../config/env-registry.js", () => ({
  ...actualEnvRegistry,
  getIsContainerized: getIsContainerizedMock,
}));

// `loadConfig` is only read to feed the flag gate (mocked below), so return a
// trivial object rather than touching the real on-disk loader.
const actualLoader = await import("../../../config/loader.js");
mock.module("../../../config/loader.js", () => ({
  ...actualLoader,
  loadConfig: mock(() => ({})),
}));

// The connect flag gate; default on. Cloud fail-closed tests flip it off.
const actualFlag = await import("../../../acp/acp-oauth-connect-flag.js");
const isConnectEnabledMock = mock(() => true);
mock.module("../../../acp/acp-oauth-connect-flag.js", () => ({
  ...actualFlag,
  isAcpClaudeOauthConnectEnabled: isConnectEnabledMock,
}));

const { ROUTES } = await import("../acp-claude-auth-routes.js");

const startHandler = ROUTES.find(
  (r) => r.operationId === "acp_claude_auth_start",
)!.handler;
const statusHandler = ROUTES.find(
  (r) => r.operationId === "acp_claude_auth_status",
)!.handler;
const exchangeHandler = ROUTES.find(
  (r) => r.operationId === "acp_claude_auth_exchange",
)!.handler;

const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

interface StartResult {
  mode: "loopback" | "manual";
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
    if (status.status === target) {
      return status;
    }
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
  exchangeCodeForTokensMock.mockClear();
  storeAcpClaudeTokenMock.mockClear();
  // Reset host + flag to their defaults (local host, flag on).
  getIsContainerizedMock.mockReturnValue(false);
  isConnectEnabledMock.mockReturnValue(true);
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

// ---------------------------------------------------------------------------
// start — cloud/manual branch
// ---------------------------------------------------------------------------

describe("acp_claude_auth_start (cloud/manual)", () => {
  test("flag ON + containerized returns mode:manual with the manual redirect URI", async () => {
    getIsContainerizedMock.mockReturnValue(true);
    isConnectEnabledMock.mockReturnValue(true);

    const result = (await startHandler({})) as StartResult;

    expect(result.mode).toBe("manual");
    const url = new URL(result.authorize_url);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://claude.ai/oauth/authorize",
    );
    expect(url.searchParams.get("redirect_uri")).toBe(
      CLAUDE_MANUAL_REDIRECT_URI,
    );
    expect(url.searchParams.get("client_id")).toBe(CLAUDE_CLIENT_ID);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(result.state);

    // The manual path must not bind a loopback.
    expect(prepareOAuth2FlowMock).not.toHaveBeenCalled();
    // Tracked as pending so a subsequent status poll doesn't 404.
    expect(getStatus(result.state).status).toBe("pending");
  });

  test("flag OFF + containerized fails closed with a clear message (403, no loopback)", async () => {
    getIsContainerizedMock.mockReturnValue(true);
    isConnectEnabledMock.mockReturnValue(false);

    let thrown: { statusCode?: number; message?: string } | undefined;
    try {
      await startHandler({});
    } catch (err) {
      thrown = err as { statusCode?: number; message?: string };
    }

    expect(thrown).toBeDefined();
    expect(thrown!.statusCode).toBe(403);
    expect(thrown!.message).toMatch(/not enabled/i);
    // Fail-closed: never attempts a (broken) loopback bind.
    expect(prepareOAuth2FlowMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// exchange — cloud/manual branch
// ---------------------------------------------------------------------------

describe("acp_claude_auth_exchange", () => {
  /** Start a manual flow and return its state. */
  async function startManual(): Promise<string> {
    getIsContainerizedMock.mockReturnValue(true);
    isConnectEnabledMock.mockReturnValue(true);
    const result = (await startHandler({})) as StartResult;
    return result.state;
  }

  test("valid `code#state` paste stores the token and returns ok", async () => {
    const state = await startManual();

    const res = (await exchangeHandler({
      body: { code: `auth-code-123#${state}`, state: "" },
    })) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(exchangeCodeForTokensMock).toHaveBeenCalledTimes(1);
    const call = exchangeCodeForTokensMock.mock.calls[0] as unknown as [
      unknown,
      string,
      string,
      string,
    ];
    // Exchanged with the code portion + the manual redirect URI.
    expect(call[1]).toBe("auth-code-123");
    expect(call[2]).toBe(CLAUDE_MANUAL_REDIRECT_URI);
    expect(call[3]).toBeTruthy(); // PKCE verifier from the start call
    expect(storeAcpClaudeTokenMock).toHaveBeenCalledWith("sk-ant-oat-manual");

    // The pending entry is consumed — a second exchange fails.
    await expect(
      exchangeHandler({ body: { code: `x#${state}`, state: "" } }),
    ).rejects.toThrow(/invalid or expired/i);
  });

  test("raw code + separate state stores the token and returns ok", async () => {
    const state = await startManual();

    const res = (await exchangeHandler({
      body: { code: "raw-code-xyz", state },
    })) as { ok: boolean };

    expect(res.ok).toBe(true);
    const call = exchangeCodeForTokensMock.mock.calls[0] as unknown as [
      unknown,
      string,
    ];
    expect(call[1]).toBe("raw-code-xyz");
    expect(storeAcpClaudeTokenMock).toHaveBeenCalledWith("sk-ant-oat-manual");
  });

  test("malformed paste (no `#`, no state) is rejected", async () => {
    await startManual();

    await expect(
      exchangeHandler({ body: { code: "no-hash-no-state", state: "" } }),
    ).rejects.toThrow(/code#state|malformed/i);
    expect(exchangeCodeForTokensMock).not.toHaveBeenCalled();
  });

  test("unknown state is rejected cleanly", async () => {
    await expect(
      exchangeHandler({ body: { code: "some-code#never-started", state: "" } }),
    ).rejects.toThrow(/invalid or expired/i);
    expect(exchangeCodeForTokensMock).not.toHaveBeenCalled();
  });

  test("expired state is rejected cleanly", async () => {
    const state = await startManual();

    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60 * 1000; // past the 10-minute TTL
    try {
      await expect(
        exchangeHandler({ body: { code: `c#${state}`, state: "" } }),
      ).rejects.toThrow(/expired/i);
    } finally {
      Date.now = realNow;
    }
    expect(exchangeCodeForTokensMock).not.toHaveBeenCalled();
  });

  test("exchange failure yields a 400 (not 500) and the flow is not left pending", async () => {
    const state = await startManual();
    exchangeCodeForTokensMock.mockImplementationOnce(async () => {
      throw new Error("token endpoint rejected the code");
    });

    let thrown: { statusCode?: number } | undefined;
    try {
      await exchangeHandler({ body: { code: `bad#${state}`, state: "" } });
    } catch (err) {
      thrown = err as { statusCode?: number };
    }
    expect(thrown).toBeDefined();
    expect(thrown!.statusCode).toBe(400);

    // The flow is marked errored (not left pending) and the token is not stored.
    expect(getStatus(state).status).toBe("error");
    expect(storeAcpClaudeTokenMock).not.toHaveBeenCalled();
  });
});
