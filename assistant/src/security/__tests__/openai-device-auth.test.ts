/**
 * Tests for OpenAI's Codex device-code authorization client.
 *
 * `fetch`, the poll delay, and the clock are injected so the suite drives the
 * real protocol shapes (string `interval`, 403 pending bodies, terminal error
 * codes) without network or wall-clock waits.
 */

import { describe, expect, test } from "bun:test";

import type { OAuth2Config } from "../oauth2.js";
import {
  completeDeviceAuth,
  DeviceAuthError,
  type DeviceAuthRequest,
  OPENAI_DEVICE_AUTH_TOKEN_URL,
  OPENAI_DEVICE_AUTH_USERCODE_URL,
  OPENAI_DEVICE_REDIRECT_URI,
  OPENAI_DEVICE_VERIFICATION_URL,
  pollForAuthorizationCode,
  requestDeviceCode,
} from "../openai-device-auth.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const OAUTH_CONFIG: OAuth2Config = {
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenExchangeUrl: "https://auth.openai.com/oauth/token",
  clientId: CLIENT_ID,
  scopes: ["openid", "profile", "email", "offline_access"],
  scopeSeparator: " ",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const PENDING_BODY = {
  error: {
    code: "deviceauth_authorization_pending",
    message: "Device authorization is pending. Please try again.",
  },
};

function pendingRequest(overrides: Partial<DeviceAuthRequest> = {}) {
  return {
    deviceAuthId: "deviceauth_abc123",
    userCode: "AMOO-SIISY",
    verificationUrl: OPENAI_DEVICE_VERIFICATION_URL,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    intervalSeconds: 5,
    ...overrides,
  } satisfies DeviceAuthRequest;
}

/** Serve the given responses in order; throw when the queue runs dry. */
function queuedFetch(responses: Response[]): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; body: unknown }>;
} {
  const calls: Array<{ url: string; body: unknown }> = [];
  const queue = [...responses];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const raw = init?.body === undefined ? undefined : String(init.body);
    let body: unknown = raw;
    if (raw !== undefined) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    calls.push({ url: String(url), body });
    const next = queue.shift();
    if (!next) {
      throw new Error("fetch called more times than the test queued responses");
    }
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const noSleep = async () => {};

describe("requestDeviceCode", () => {
  test("parses the usercode response and its string interval", async () => {
    const { fetchImpl, calls } = queuedFetch([
      jsonResponse(200, {
        device_auth_id: "deviceauth_abc123",
        user_code: "AMOO-SIISY",
        interval: "7",
        expires_at: "2099-01-01T00:00:00.000000+00:00",
      }),
    ]);

    const result = await requestDeviceCode(CLIENT_ID, { fetchImpl });

    expect(calls[0]?.url).toBe(OPENAI_DEVICE_AUTH_USERCODE_URL);
    expect(calls[0]?.body).toEqual({ client_id: CLIENT_ID });
    expect(result.deviceAuthId).toBe("deviceauth_abc123");
    expect(result.userCode).toBe("AMOO-SIISY");
    expect(result.intervalSeconds).toBe(7);
    expect(result.expiresAt).toBe("2099-01-01T00:00:00.000000+00:00");
    expect(result.verificationUrl).toBe(OPENAI_DEVICE_VERIFICATION_URL);
  });

  test("falls back to a 5 second interval when it is missing or unusable", async () => {
    const { fetchImpl } = queuedFetch([
      jsonResponse(200, {
        device_auth_id: "deviceauth_abc123",
        user_code: "AMOO-SIISY",
        interval: "not-a-number",
        expires_at: "2099-01-01T00:00:00Z",
      }),
      jsonResponse(200, {
        device_auth_id: "deviceauth_abc123",
        user_code: "AMOO-SIISY",
        expires_at: "2099-01-01T00:00:00Z",
      }),
    ]);

    expect(
      (await requestDeviceCode(CLIENT_ID, { fetchImpl })).intervalSeconds,
    ).toBe(5);
    expect(
      (await requestDeviceCode(CLIENT_ID, { fetchImpl })).intervalSeconds,
    ).toBe(5);
  });

  test("surfaces the provider error code on a failed mint", async () => {
    const { fetchImpl } = queuedFetch([
      jsonResponse(400, {
        error: { code: "deviceauth_disabled", message: "Device auth is off." },
      }),
    ]);

    const err = (await requestDeviceCode(CLIENT_ID, { fetchImpl }).catch(
      (e: unknown) => e,
    )) as DeviceAuthError;

    expect(err).toBeInstanceOf(DeviceAuthError);
    expect(err.code).toBe("deviceauth_disabled");
    expect(err.message).toBe("Device auth is off.");
  });
});

describe("pollForAuthorizationCode", () => {
  test("keeps polling through pending 403s and returns the PKCE pair", async () => {
    const { fetchImpl, calls } = queuedFetch([
      jsonResponse(403, PENDING_BODY),
      jsonResponse(404, PENDING_BODY),
      jsonResponse(200, {
        authorization_code: "auth-code-1",
        code_challenge: "challenge-1",
        code_verifier: "verifier-1",
      }),
    ]);

    const result = await pollForAuthorizationCode(pendingRequest(), {
      fetchImpl,
      sleep: noSleep,
    });

    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe(OPENAI_DEVICE_AUTH_TOKEN_URL);
    expect(calls[0]?.body).toEqual({
      device_auth_id: "deviceauth_abc123",
      user_code: "AMOO-SIISY",
    });
    expect(result).toEqual({
      authorizationCode: "auth-code-1",
      codeVerifier: "verifier-1",
      codeChallenge: "challenge-1",
    });
  });

  test("stops on a non-pending error body and keeps its code", async () => {
    const { fetchImpl } = queuedFetch([
      jsonResponse(403, PENDING_BODY),
      jsonResponse(403, {
        error: {
          code: "deviceauth_not_enabled",
          message: "Device code authorization is disabled for this account.",
        },
      }),
    ]);

    const err = (await pollForAuthorizationCode(pendingRequest(), {
      fetchImpl,
      sleep: noSleep,
    }).catch((e: unknown) => e)) as DeviceAuthError;

    expect(err).toBeInstanceOf(DeviceAuthError);
    expect(err.code).toBe("deviceauth_not_enabled");
    expect(err.message).toBe(
      "Device code authorization is disabled for this account.",
    );
  });

  test("gives up once the code's expiry passes", async () => {
    let clock = 1_000;
    const { fetchImpl, calls } = queuedFetch([
      jsonResponse(403, PENDING_BODY),
      jsonResponse(403, PENDING_BODY),
    ]);

    const err = (await pollForAuthorizationCode(
      pendingRequest({ expiresAt: new Date(clock + 10_000).toISOString() }),
      {
        fetchImpl,
        now: () => clock,
        sleep: async () => {
          clock += 6_000;
        },
      },
    ).catch((e: unknown) => e)) as DeviceAuthError;

    expect(calls).toHaveLength(2);
    expect(err).toBeInstanceOf(DeviceAuthError);
    expect(err.code).toBe("expired_token");
  });

  test("retries transport failures and 5xx responses", async () => {
    const { fetchImpl } = queuedFetch([
      jsonResponse(503, { error: { code: "server_error" } }),
      jsonResponse(200, {
        authorization_code: "auth-code-2",
        code_verifier: "verifier-2",
      }),
    ]);

    const result = await pollForAuthorizationCode(pendingRequest(), {
      fetchImpl,
      sleep: noSleep,
    });

    expect(result.authorizationCode).toBe("auth-code-2");
    expect(result.codeChallenge).toBeUndefined();
  });

  test("aborts when the caller's signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchImpl } = queuedFetch([]);

    const err = (await pollForAuthorizationCode(pendingRequest(), {
      fetchImpl,
      sleep: noSleep,
      signal: controller.signal,
    }).catch((e: unknown) => e)) as DeviceAuthError;

    expect(err).toBeInstanceOf(DeviceAuthError);
    expect(err.code).toBe("aborted");
  });

  test("stops polling when the signal fires between polls", async () => {
    const controller = new AbortController();
    const { fetchImpl, calls } = queuedFetch([jsonResponse(403, PENDING_BODY)]);

    const err = (await pollForAuthorizationCode(pendingRequest(), {
      fetchImpl,
      sleep: async () => {
        controller.abort();
      },
      signal: controller.signal,
    }).catch((e: unknown) => e)) as DeviceAuthError;

    expect(err).toBeInstanceOf(DeviceAuthError);
    expect(err.code).toBe("aborted");
    expect(calls.length).toBe(1);
  });
});

describe("completeDeviceAuth", () => {
  test("exchanges the device authorization code at the token endpoint", async () => {
    const { fetchImpl, calls } = queuedFetch([
      jsonResponse(200, {
        authorization_code: "auth-code-3",
        code_verifier: "verifier-3",
      }),
      jsonResponse(200, {
        access_token: "access-3",
        refresh_token: "refresh-3",
        expires_in: 3600,
      }),
    ]);

    // `exchangeCodeForTokens` uses the global fetch, so swap it for the queue.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const result = await completeDeviceAuth(OAUTH_CONFIG, pendingRequest(), {
        fetchImpl,
        sleep: noSleep,
      });

      expect(result.tokens.accessToken).toBe("access-3");
      expect(result.tokens.refreshToken).toBe("refresh-3");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls[1]?.url).toBe(OAUTH_CONFIG.tokenExchangeUrl);
    const exchangeBody = new URLSearchParams(String(calls[1]?.body ?? ""));
    expect(exchangeBody.get("grant_type")).toBe("authorization_code");
    expect(exchangeBody.get("code")).toBe("auth-code-3");
    expect(exchangeBody.get("code_verifier")).toBe("verifier-3");
    expect(exchangeBody.get("redirect_uri")).toBe(OPENAI_DEVICE_REDIRECT_URI);
    expect(exchangeBody.get("client_id")).toBe(CLIENT_ID);
  });

  test("hands the signal to the exchange and fails a flow cancelled during it", async () => {
    const controller = new AbortController();
    const queue = [
      jsonResponse(200, {
        authorization_code: "auth-code-4",
        code_verifier: "verifier-4",
      }),
      jsonResponse(200, { access_token: "access-4" }),
    ];
    const seenSignals: Array<AbortSignal | null | undefined> = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seenSignals.push(init?.signal);
      const next = queue.shift();
      if (!next) {
        throw new Error("fetch called more times than the test queued");
      }
      // The cancel lands while the token request is in flight.
      if (queue.length === 0) {
        controller.abort();
      }
      return next;
    }) as unknown as typeof fetch;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const err = (await completeDeviceAuth(OAUTH_CONFIG, pendingRequest(), {
        fetchImpl,
        sleep: noSleep,
        signal: controller.signal,
      }).catch((e: unknown) => e)) as DeviceAuthError;

      expect(err).toBeInstanceOf(DeviceAuthError);
      expect(err.code).toBe("aborted");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(seenSignals[1]).toBe(controller.signal);
  });
});
