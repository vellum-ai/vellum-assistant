import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Mock logger before importing any code that uses it.
// ---------------------------------------------------------------------------

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

import type { DeviceCodeConfig } from "../oauth2-device-code.js";
import {
  DeviceCodeError,
  OPENAI_DEVICE_CODE_CONFIG,
  pollForToken,
  requestDeviceCode,
  startDeviceCodeFlow,
} from "../oauth2-device-code.js";

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  globalThis.fetch = handler as typeof globalThis.fetch;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const TEST_CONFIG: DeviceCodeConfig = {
  deviceCodeUrl: "https://auth.example.com/device/code",
  tokenUrl: "https://auth.example.com/oauth/token",
  clientId: "test-client-id",
  scopes: ["openid", "profile"],
  audience: "https://api.example.com",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("oauth2-device-code", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("OPENAI_DEVICE_CODE_CONFIG", () => {
    test("has the expected OpenAI Codex values", () => {
      expect(OPENAI_DEVICE_CODE_CONFIG.deviceCodeUrl).toBe(
        "https://auth.openai.com/oauth/device/code",
      );
      expect(OPENAI_DEVICE_CODE_CONFIG.tokenUrl).toBe(
        "https://auth.openai.com/oauth/token",
      );
      expect(OPENAI_DEVICE_CODE_CONFIG.clientId).toBe(
        "app_EMoamEEZ73f0CkXaXp7hrann",
      );
      expect(OPENAI_DEVICE_CODE_CONFIG.scopes).toEqual([
        "openid",
        "profile",
        "email",
        "offline_access",
      ]);
      expect(OPENAI_DEVICE_CODE_CONFIG.audience).toBe("https://chatgpt.com");
    });
  });

  describe("requestDeviceCode", () => {
    test("sends correct request and parses response", async () => {
      let capturedUrl = "";
      let capturedBody = "";

      mockFetch(async (url, init) => {
        capturedUrl = url;
        capturedBody = init?.body?.toString() ?? "";
        return jsonResponse({
          device_code: "dev-code-123",
          user_code: "ABCD-1234",
          verification_uri: "https://auth.example.com/activate",
          verification_uri_complete:
            "https://auth.example.com/activate?user_code=ABCD-1234",
          expires_in: 900,
          interval: 5,
        });
      });

      const result = await requestDeviceCode(TEST_CONFIG);

      expect(capturedUrl).toBe(TEST_CONFIG.deviceCodeUrl);
      const params = new URLSearchParams(capturedBody);
      expect(params.get("client_id")).toBe("test-client-id");
      expect(params.get("scope")).toBe("openid profile");
      expect(params.get("audience")).toBe("https://api.example.com");

      expect(result.deviceCode).toBe("dev-code-123");
      expect(result.userCode).toBe("ABCD-1234");
      expect(result.verificationUri).toBe(
        "https://auth.example.com/activate",
      );
      expect(result.verificationUriComplete).toBe(
        "https://auth.example.com/activate?user_code=ABCD-1234",
      );
      expect(result.expiresIn).toBe(900);
      expect(result.interval).toBe(5);
    });

    test("defaults interval to 5 when not provided", async () => {
      mockFetch(async () =>
        jsonResponse({
          device_code: "dev-code-123",
          user_code: "ABCD-1234",
          verification_uri: "https://auth.example.com/activate",
          expires_in: 900,
        }),
      );

      const result = await requestDeviceCode(TEST_CONFIG);
      expect(result.interval).toBe(5);
    });

    test("omits audience when not configured", async () => {
      let capturedBody = "";
      mockFetch(async (_url, init) => {
        capturedBody = init?.body?.toString() ?? "";
        return jsonResponse({
          device_code: "dev-code-123",
          user_code: "ABCD-1234",
          verification_uri: "https://auth.example.com/activate",
          expires_in: 900,
          interval: 5,
        });
      });

      const configNoAudience: DeviceCodeConfig = {
        ...TEST_CONFIG,
        audience: undefined,
      };
      await requestDeviceCode(configNoAudience);

      const params = new URLSearchParams(capturedBody);
      expect(params.has("audience")).toBe(false);
    });

    test("throws DeviceCodeError on non-OK response", async () => {
      mockFetch(async () =>
        jsonResponse({ error: "invalid_client" }, 400),
      );

      await expect(requestDeviceCode(TEST_CONFIG)).rejects.toThrow(
        DeviceCodeError,
      );
      try {
        await requestDeviceCode(TEST_CONFIG);
      } catch (err) {
        expect(err).toBeInstanceOf(DeviceCodeError);
        expect((err as DeviceCodeError).code).toBe("request_failed");
      }
    });
  });

  describe("pollForToken", () => {
    test("returns tokens on immediate success", async () => {
      mockFetch(async () =>
        jsonResponse({
          access_token: "at-123",
          refresh_token: "rt-456",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "openid profile",
        }),
      );

      const result = await pollForToken(
        TEST_CONFIG,
        "dev-code-123",
        0.01, // near-zero interval for test speed
        30,
      );

      expect(result.accessToken).toBe("at-123");
      expect(result.refreshToken).toBe("rt-456");
      expect(result.expiresIn).toBe(3600);
      expect(result.tokenType).toBe("Bearer");
      expect(result.scope).toBe("openid profile");
    });

    test("polls through authorization_pending then succeeds", async () => {
      let callCount = 0;

      mockFetch(async () => {
        callCount++;
        if (callCount < 3) {
          return jsonResponse(
            { error: "authorization_pending" },
            403,
          );
        }
        return jsonResponse({
          access_token: "at-after-pending",
          refresh_token: "rt-after-pending",
          expires_in: 3600,
        });
      });

      const result = await pollForToken(
        TEST_CONFIG,
        "dev-code-123",
        0.01,
        30,
      );

      expect(result.accessToken).toBe("at-after-pending");
      expect(callCount).toBe(3);
    });

    test("increases interval on slow_down", async () => {
      let callCount = 0;
      const sleepDelays: number[] = [];

      const fakeSleep = async (ms: number) => {
        sleepDelays.push(ms);
      };

      mockFetch(async () => {
        callCount++;
        if (callCount === 1) {
          return jsonResponse({ error: "slow_down" }, 403);
        }
        return jsonResponse({
          access_token: "at-slow",
          expires_in: 3600,
        });
      });

      const result = await pollForToken(
        TEST_CONFIG,
        "dev-code-123",
        2,
        60,
        undefined,
        fakeSleep,
      );

      expect(result.accessToken).toBe("at-slow");
      expect(callCount).toBe(2);
      // First sleep: initial interval (2s = 2000ms)
      expect(sleepDelays[0]).toBe(2000);
      // Second sleep: initial interval + 5s = 7s = 7000ms (per RFC 8628)
      expect(sleepDelays[1]).toBe(7000);
    });

    test("throws on expired_token", async () => {
      mockFetch(async () =>
        jsonResponse({ error: "expired_token" }, 403),
      );

      try {
        await pollForToken(TEST_CONFIG, "dev-code-123", 0.01, 30);
        expect(true).toBe(false); // should not reach
      } catch (err) {
        expect(err).toBeInstanceOf(DeviceCodeError);
        expect((err as DeviceCodeError).code).toBe("expired_token");
        expect((err as DeviceCodeError).message).toContain("expired");
      }
    });

    test("throws on access_denied", async () => {
      mockFetch(async () =>
        jsonResponse({ error: "access_denied" }, 403),
      );

      try {
        await pollForToken(TEST_CONFIG, "dev-code-123", 0.01, 30);
        expect(true).toBe(false); // should not reach
      } catch (err) {
        expect(err).toBeInstanceOf(DeviceCodeError);
        expect((err as DeviceCodeError).code).toBe("access_denied");
        expect((err as DeviceCodeError).message).toContain("denied");
      }
    });

    test("throws on abort signal", async () => {
      const ac = new AbortController();
      // Abort immediately
      ac.abort();

      try {
        await pollForToken(TEST_CONFIG, "dev-code-123", 0.01, 30, ac.signal);
        expect(true).toBe(false); // should not reach
      } catch (err) {
        expect(err).toBeInstanceOf(DeviceCodeError);
        expect((err as DeviceCodeError).code).toBe("aborted");
      }
    });

    test("aborts mid-poll when signal fires", async () => {
      const ac = new AbortController();
      let callCount = 0;

      mockFetch(async () => {
        callCount++;
        // Abort after first pending response
        if (callCount === 1) {
          ac.abort();
        }
        return jsonResponse(
          { error: "authorization_pending" },
          403,
        );
      });

      try {
        await pollForToken(TEST_CONFIG, "dev-code-123", 0.01, 30, ac.signal);
        expect(true).toBe(false); // should not reach
      } catch (err) {
        expect(err).toBeInstanceOf(DeviceCodeError);
        expect((err as DeviceCodeError).code).toBe("aborted");
      }
    });

    test("sends correct grant_type and parameters", async () => {
      let capturedBody = "";

      mockFetch(async (_url, init) => {
        capturedBody = init?.body?.toString() ?? "";
        return jsonResponse({
          access_token: "at-123",
          expires_in: 3600,
        });
      });

      await pollForToken(TEST_CONFIG, "dev-code-xyz", 0.01, 30);

      const params = new URLSearchParams(capturedBody);
      expect(params.get("grant_type")).toBe(
        "urn:ietf:params:oauth:grant-type:device_code",
      );
      expect(params.get("device_code")).toBe("dev-code-xyz");
      expect(params.get("client_id")).toBe("test-client-id");
    });

    test("throws on unexpected error code", async () => {
      mockFetch(async () =>
        jsonResponse({ error: "server_error" }, 500),
      );

      try {
        await pollForToken(TEST_CONFIG, "dev-code-123", 0.01, 30);
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(DeviceCodeError);
        expect((err as DeviceCodeError).code).toBe("request_failed");
      }
    });

    test("retries on network error then succeeds", async () => {
      let callCount = 0;

      mockFetch(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error("Network error");
        }
        return jsonResponse({
          access_token: "at-retry",
          expires_in: 3600,
        });
      });

      const result = await pollForToken(
        TEST_CONFIG,
        "dev-code-123",
        0.01,
        30,
      );

      expect(result.accessToken).toBe("at-retry");
      expect(callCount).toBe(2);
    });
  });

  describe("startDeviceCodeFlow", () => {
    test("runs full flow: device code request then token poll", async () => {
      let callCount = 0;

      mockFetch(async (url) => {
        callCount++;
        if (url === TEST_CONFIG.deviceCodeUrl) {
          return jsonResponse({
            device_code: "full-flow-dc",
            user_code: "FULL-1234",
            verification_uri: "https://auth.example.com/activate",
            expires_in: 900,
            interval: 0.01,
          });
        }
        // Token endpoint — succeed on second poll
        if (callCount === 2) {
          return jsonResponse(
            { error: "authorization_pending" },
            403,
          );
        }
        return jsonResponse({
          access_token: "at-full-flow",
          refresh_token: "rt-full-flow",
          expires_in: 3600,
        });
      });

      const result = await startDeviceCodeFlow(TEST_CONFIG);

      expect(result.init.deviceCode).toBe("full-flow-dc");
      expect(result.init.userCode).toBe("FULL-1234");
      expect(result.init.verificationUri).toBe(
        "https://auth.example.com/activate",
      );
      expect(result.tokens.accessToken).toBe("at-full-flow");
      expect(result.tokens.refreshToken).toBe("rt-full-flow");
    });

    test("propagates abort signal to poll", async () => {
      const ac = new AbortController();

      mockFetch(async (url) => {
        if (url === TEST_CONFIG.deviceCodeUrl) {
          return jsonResponse({
            device_code: "abort-dc",
            user_code: "ABRT-1234",
            verification_uri: "https://auth.example.com/activate",
            expires_in: 900,
            interval: 0.01,
          });
        }
        // Abort before returning token
        ac.abort();
        return jsonResponse(
          { error: "authorization_pending" },
          403,
        );
      });

      try {
        await startDeviceCodeFlow(TEST_CONFIG, ac.signal);
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(DeviceCodeError);
        expect((err as DeviceCodeError).code).toBe("aborted");
      }
    });
  });
});
