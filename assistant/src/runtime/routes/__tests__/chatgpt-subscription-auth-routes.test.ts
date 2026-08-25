/**
 * Tests for the ChatGPT subscription auth routes.
 *
 * The device-code path is driven by mocking `openai-device-auth` so the route's
 * own contract is under test: `device-auth` returns the user code immediately
 * and the status route reports `pending` until the background poll settles,
 * then `connected` or `error` with the provider's error code. The credential +
 * connection store is mocked so no CES or database write is attempted.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  OAuth2FlowResult,
  OAuth2TokenResult,
} from "../../../security/oauth2.js";
import type { DeviceAuthRequest } from "../../../security/openai-device-auth.js";

// ---------------------------------------------------------------------------
// Mocks, wired BEFORE importing the module under test.
// ---------------------------------------------------------------------------

const actualDeviceAuth =
  await import("../../../security/openai-device-auth.js");
const { DeviceAuthError } = actualDeviceAuth;

const DEVICE_REQUEST: DeviceAuthRequest = {
  deviceAuthId: "deviceauth_abc123",
  userCode: "AMOO-SIISY",
  verificationUrl: "https://auth.openai.com/codex/device",
  expiresAt: "2099-01-01T00:00:00Z",
  intervalSeconds: 5,
};

// Every mint gets its own id, as OpenAI's do, so one flow's background poll can
// never settle a key another flow owns.
let mintCount = 0;
let lastMinted: DeviceAuthRequest = DEVICE_REQUEST;

const requestDeviceCodeMock = mock(async () => {
  mintCount++;
  lastMinted = {
    ...DEVICE_REQUEST,
    deviceAuthId: `${DEVICE_REQUEST.deviceAuthId}_${mintCount}`,
  };
  return lastMinted;
});

/** Resolver handles for the in-flight poll each test drives by hand. */
let resolveDeviceAuth: (result: OAuth2FlowResult) => void = () => {};
let rejectDeviceAuth: (err: unknown) => void = () => {};
/** Every signal the route handed the poll, in mint order. */
const pollSignals: AbortSignal[] = [];
/**
 * Whether an abort settles the mocked poll. Off for the races where the poll
 * has already returned an authorization code and the exchange is mid-flight,
 * which is exactly the window the route has to guard on its own.
 */
let rejectPollOnAbort = true;

const completeDeviceAuthMock = mock(
  (
    _config: unknown,
    _request: DeviceAuthRequest,
    options: { signal?: AbortSignal } = {},
  ) =>
    new Promise<OAuth2FlowResult>((resolve, reject) => {
      resolveDeviceAuth = resolve;
      rejectDeviceAuth = reject;
      if (options.signal) {
        pollSignals.push(options.signal);
        // The real poll throws once the signal fires; mirroring that keeps the
        // route's own settle path under test.
        options.signal.addEventListener("abort", () => {
          if (!rejectPollOnAbort) {
            return;
          }
          reject(
            new DeviceAuthError(
              "Device authorization was cancelled.",
              "aborted",
            ),
          );
        });
      }
    }),
);

mock.module("../../../security/openai-device-auth.js", () => ({
  ...actualDeviceAuth,
  requestDeviceCode: requestDeviceCodeMock,
  completeDeviceAuth: completeDeviceAuthMock,
}));

const actualChatgptAuth =
  await import("../../../providers/inference/chatgpt-subscription-auth.js");
/** When set, the store blocks on it, so a test can interleave a cancel. */
let storeGate: Promise<void> | null = null;
const storeChatgptSubscriptionTokensMock = mock(
  async (_tokens: OAuth2TokenResult) => {
    if (storeGate) {
      await storeGate;
    }
  },
);
mock.module(
  "../../../providers/inference/chatgpt-subscription-auth.js",
  () => ({
    ...actualChatgptAuth,
    storeChatgptSubscriptionTokens: storeChatgptSubscriptionTokensMock,
  }),
);

const { ROUTES } = await import("../chatgpt-subscription-auth-routes.js");

const startDeviceAuthHandler = ROUTES.find(
  (r) => r.operationId === "inference_chatgpt_subscription_device_auth",
)!.handler;
const deviceAuthStatusHandler = ROUTES.find(
  (r) => r.operationId === "inference_chatgpt_subscription_device_auth_status",
)!.handler;
const cancelDeviceAuthHandler = ROUTES.find(
  (r) => r.operationId === "inference_chatgpt_subscription_device_auth_cancel",
)!.handler;
const startAuthHandler = ROUTES.find(
  (r) => r.operationId === "inference_chatgpt_subscription_auth",
)!.handler;

interface DeviceStartResult {
  state: string;
  user_code: string;
  verification_url: string;
  expires_at: string;
  interval_seconds: number;
}

interface StatusResult {
  status: "pending" | "connected" | "error";
  error?: string;
  error_code?: string;
}

const TOKENS: OAuth2FlowResult = {
  tokens: {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresIn: 3600,
  },
  grantedScopes: ["openid"],
  rawTokenResponse: {},
};

async function startDeviceAuth(): Promise<DeviceStartResult> {
  return (await startDeviceAuthHandler({})) as DeviceStartResult;
}

function readStatus(state: string): StatusResult {
  return deviceAuthStatusHandler({ pathParams: { state } }) as StatusResult;
}

function cancelDeviceAuth(state: string): { cancelled: boolean } {
  return cancelDeviceAuthHandler({ pathParams: { state } }) as {
    cancelled: boolean;
  };
}

/** Let the background `.then`/`.catch` chain run before asserting. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("chatgpt subscription device auth routes", () => {
  beforeEach(() => {
    requestDeviceCodeMock.mockClear();
    completeDeviceAuthMock.mockClear();
    storeChatgptSubscriptionTokensMock.mockClear();
    pollSignals.length = 0;
    rejectPollOnAbort = true;
    storeGate = null;
  });

  test("returns the user code immediately and starts pending", async () => {
    const result = await startDeviceAuth();

    expect(result).toEqual({
      state: lastMinted.deviceAuthId,
      user_code: "AMOO-SIISY",
      verification_url: "https://auth.openai.com/codex/device",
      expires_at: "2099-01-01T00:00:00Z",
      interval_seconds: 5,
    });
    expect(completeDeviceAuthMock).toHaveBeenCalledTimes(1);
    expect(readStatus(result.state)).toEqual({ status: "pending" });
  });

  test("stores the tokens and flips to connected when the poll succeeds", async () => {
    const result = await startDeviceAuth();

    resolveDeviceAuth(TOKENS);
    await flush();

    expect(storeChatgptSubscriptionTokensMock).toHaveBeenCalledTimes(1);
    expect(storeChatgptSubscriptionTokensMock.mock.calls[0]?.[0]).toEqual(
      TOKENS.tokens,
    );
    expect(readStatus(result.state)).toEqual({ status: "connected" });
  });

  test("reports the provider error code when the poll fails", async () => {
    const result = await startDeviceAuth();

    rejectDeviceAuth(
      new DeviceAuthError("Device auth is off.", "deviceauth_not_enabled"),
    );
    await flush();

    expect(storeChatgptSubscriptionTokensMock).not.toHaveBeenCalled();
    expect(readStatus(result.state)).toEqual({
      status: "error",
      error: "Device auth is off.",
      error_code: "deviceauth_not_enabled",
    });
  });

  test("falls back to a generic code for a non-device-auth failure", async () => {
    const result = await startDeviceAuth();

    rejectDeviceAuth(new Error("token exchange exploded"));
    await flush();

    expect(readStatus(result.state)).toEqual({
      status: "error",
      error: "token exchange exploded",
      error_code: "device_auth_failed",
    });
  });

  test("404s an unknown state", async () => {
    expect(() => readStatus("deviceauth_missing")).toThrow(
      /No active ChatGPT device sign-in/,
    );
  });
});

describe("chatgpt subscription device auth cancellation", () => {
  beforeEach(() => {
    requestDeviceCodeMock.mockClear();
    completeDeviceAuthMock.mockClear();
    storeChatgptSubscriptionTokensMock.mockClear();
    pollSignals.length = 0;
    rejectPollOnAbort = true;
    storeGate = null;
  });

  test("stops the poll and reports the flow aborted", async () => {
    const result = await startDeviceAuth();

    expect(cancelDeviceAuth(result.state)).toEqual({ cancelled: true });

    expect(pollSignals[0]?.aborted).toBe(true);
    const status = readStatus(result.state);
    expect(status.status).toBe("error");
    expect(status.error_code).toBe("aborted");
    await flush();
    expect(readStatus(result.state).error_code).toBe("aborted");
  });

  test("leaves a flow that already settled alone", async () => {
    const result = await startDeviceAuth();

    resolveDeviceAuth(TOKENS);
    await flush();

    expect(cancelDeviceAuth(result.state)).toEqual({ cancelled: false });
    expect(readStatus(result.state)).toEqual({ status: "connected" });
  });

  test("starting a flow aborts the one before it", async () => {
    const first = await startDeviceAuth();
    const second = await startDeviceAuth();
    await flush();

    expect(second.state).not.toBe(first.state);
    expect(pollSignals[0]?.aborted).toBe(true);
    expect(pollSignals[1]?.aborted).toBe(false);

    const firstStatus = readStatus(first.state);
    expect(firstStatus.status).toBe("error");
    expect(firstStatus.error_code).toBe("aborted");
    expect(readStatus(second.state)).toEqual({ status: "pending" });
  });

  test("404s an unknown state", async () => {
    expect(() => cancelDeviceAuth("deviceauth_missing")).toThrow(
      /No active ChatGPT device sign-in/,
    );
  });

  test("discards tokens from a flow cancelled during the exchange", async () => {
    rejectPollOnAbort = false;
    const result = await startDeviceAuth();

    expect(cancelDeviceAuth(result.state)).toEqual({ cancelled: true });
    resolveDeviceAuth(TOKENS);
    await flush();

    expect(storeChatgptSubscriptionTokensMock).not.toHaveBeenCalled();
    const status = readStatus(result.state);
    expect(status.status).toBe("error");
    expect(status.error_code).toBe("aborted");
  });

  test("leaves a flow cancelled mid-store marked aborted", async () => {
    rejectPollOnAbort = false;
    let releaseStore = () => {};
    storeGate = new Promise<void>((resolve) => {
      releaseStore = resolve;
    });
    const result = await startDeviceAuth();

    resolveDeviceAuth(TOKENS);
    await flush();
    expect(storeChatgptSubscriptionTokensMock).toHaveBeenCalledTimes(1);

    expect(cancelDeviceAuth(result.state)).toEqual({ cancelled: true });
    releaseStore();
    await flush();

    const status = readStatus(result.state);
    expect(status.status).toBe("error");
    expect(status.error_code).toBe("aborted");
  });

  test("a superseded flow cannot store over the one that replaced it", async () => {
    rejectPollOnAbort = false;
    const first = await startDeviceAuth();
    const resolveFirst = resolveDeviceAuth;
    const second = await startDeviceAuth();

    resolveFirst(TOKENS);
    await flush();

    expect(storeChatgptSubscriptionTokensMock).not.toHaveBeenCalled();
    expect(readStatus(first.state).error_code).toBe("aborted");
    expect(readStatus(second.state)).toEqual({ status: "pending" });
  });
});

describe("chatgpt subscription paste flow", () => {
  test("builds a PKCE authorize URL against OpenAI's client", async () => {
    const result = (await startAuthHandler({})) as {
      authorize_url: string;
      state: string;
    };

    const url = new URL(result.authorize_url);
    expect(url.origin + url.pathname).toBe(
      "https://auth.openai.com/oauth/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe(
      "app_EMoamEEZ73f0CkXaXp7hrann",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(result.state);
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:1455/auth/callback",
    );
    expect(url.searchParams.get("id_token_add_organizations")).toBe("true");
  });
});
