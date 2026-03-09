/**
 * Tests for TwilioConversationRelayProvider — signature validation,
 * fail-closed auth token behavior, and caller ID eligibility checks.
 */
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "twilio-provider-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Start with a configured auth token
let mockAuthToken: string | undefined = "test-auth-token-secret";
let mockAccountSid: string | undefined = "AC_test_account";

mock.module("../config/loader.js", () => ({
  loadConfig: () => ({
    twilio: { accountSid: mockAccountSid },
  }),
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (key: string) => {
    if (key === "credential:twilio:auth_token") return mockAuthToken;
    if (key === "credential:twilio:account_sid") return mockAccountSid;
    return undefined;
  },
}));

import { TwilioConversationRelayProvider } from "../calls/twilio-provider.js";

// ── Helpers ────────────────────────────────────────────────────────────

function computeValidSignature(
  url: string,
  params: Record<string, string>,
  authToken: string,
): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  return createHmac("sha1", authToken).update(data).digest("base64");
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("TwilioConversationRelayProvider", () => {
  beforeEach(() => {
    mockAuthToken = "test-auth-token-secret";
    mockAccountSid = "AC_test_account";
  });

  describe("verifyWebhookSignature", () => {
    const testUrl = "https://example.com/v1/calls/twilio/status";
    const testParams = { CallSid: "CA123", CallStatus: "completed" };

    test("returns true for a valid signature", () => {
      const authToken = "test-auth-token-secret";
      const sig = computeValidSignature(testUrl, testParams, authToken);
      const result = TwilioConversationRelayProvider.verifyWebhookSignature(
        testUrl,
        testParams,
        sig,
        authToken,
      );
      expect(result).toBe(true);
    });

    test("returns false for an invalid signature", () => {
      const authToken = "test-auth-token-secret";
      const result = TwilioConversationRelayProvider.verifyWebhookSignature(
        testUrl,
        testParams,
        "invalid-signature-base64",
        authToken,
      );
      expect(result).toBe(false);
    });

    test("returns false when signature is computed with a different auth token", () => {
      const authToken = "test-auth-token-secret";
      const wrongTokenSig = computeValidSignature(
        testUrl,
        testParams,
        "wrong-token",
      );
      const result = TwilioConversationRelayProvider.verifyWebhookSignature(
        testUrl,
        testParams,
        wrongTokenSig,
        authToken,
      );
      expect(result).toBe(false);
    });

    test("handles empty params", () => {
      const authToken = "test-auth-token-secret";
      const sig = computeValidSignature(testUrl, {}, authToken);
      const result = TwilioConversationRelayProvider.verifyWebhookSignature(
        testUrl,
        {},
        sig,
        authToken,
      );
      expect(result).toBe(true);
    });

    test("sorts params alphabetically for signature computation", () => {
      const authToken = "test-auth-token-secret";
      const params = { Zebra: "1", Alpha: "2", Middle: "3" };
      const sig = computeValidSignature(testUrl, params, authToken);
      const result = TwilioConversationRelayProvider.verifyWebhookSignature(
        testUrl,
        params,
        sig,
        authToken,
      );
      expect(result).toBe(true);
    });
  });

  describe("getAuthToken", () => {
    test("returns the auth token when configured", () => {
      mockAuthToken = "my-secret-token";
      const token = TwilioConversationRelayProvider.getAuthToken();
      expect(token).toBe("my-secret-token");
    });

    test("returns null when auth token is not configured", () => {
      mockAuthToken = undefined;
      const token = TwilioConversationRelayProvider.getAuthToken();
      expect(token).toBeNull();
    });
  });

  describe("initiateCall", () => {
    test("sends repeated StatusCallbackEvent parameters", async () => {
      const provider = new TwilioConversationRelayProvider();
      const originalFetch = globalThis.fetch;
      let capturedBody = "";

      globalThis.fetch = (async (
        _url: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        capturedBody = String(init?.body ?? "");
        return new Response(JSON.stringify({ sid: "CA_test_123" }), {
          status: 200,
        });
      }) as unknown as typeof fetch;

      try {
        const result = await provider.initiateCall({
          from: "+15550001111",
          to: "+15550002222",
          webhookUrl:
            "https://example.com/webhooks/twilio/voice?callSessionId=s1",
          statusCallbackUrl: "https://example.com/webhooks/twilio/status",
        });

        expect(result.callSid).toBe("CA_test_123");
        const params = new URLSearchParams(capturedBody);
        expect(params.getAll("StatusCallbackEvent")).toEqual([
          "initiated",
          "ringing",
          "answered",
          "completed",
        ]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("checkCallerIdEligibility", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    test("returns eligible when number is found in IncomingPhoneNumbers", async () => {
      const provider = new TwilioConversationRelayProvider();

      globalThis.fetch = (async (url: RequestInfo | URL): Promise<Response> => {
        const urlStr = String(url);
        if (urlStr.includes("/IncomingPhoneNumbers.json")) {
          return new Response(
            JSON.stringify({
              incoming_phone_numbers: [
                { sid: "PN_test", phone_number: "+15550001111" },
              ],
            }),
            { status: 200 },
          );
        }
        // Should not reach OutgoingCallerIds since IncomingPhoneNumbers matched
        return new Response(JSON.stringify({ outgoing_caller_ids: [] }), {
          status: 200,
        });
      }) as unknown as typeof fetch;

      const result = await provider.checkCallerIdEligibility("+15550001111");
      expect(result.eligible).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    test("returns eligible when number is found in OutgoingCallerIds", async () => {
      const provider = new TwilioConversationRelayProvider();

      globalThis.fetch = (async (url: RequestInfo | URL): Promise<Response> => {
        const urlStr = String(url);
        if (urlStr.includes("/IncomingPhoneNumbers.json")) {
          return new Response(JSON.stringify({ incoming_phone_numbers: [] }), {
            status: 200,
          });
        }
        if (urlStr.includes("/OutgoingCallerIds.json")) {
          return new Response(
            JSON.stringify({
              outgoing_caller_ids: [
                { sid: "PNverified", phone_number: "+15550001111" },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch;

      const result = await provider.checkCallerIdEligibility("+15550001111");
      expect(result.eligible).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    test("returns ineligible when number is not found in either endpoint", async () => {
      const provider = new TwilioConversationRelayProvider();

      globalThis.fetch = (async (url: RequestInfo | URL): Promise<Response> => {
        const urlStr = String(url);
        if (urlStr.includes("/IncomingPhoneNumbers.json")) {
          return new Response(JSON.stringify({ incoming_phone_numbers: [] }), {
            status: 200,
          });
        }
        if (urlStr.includes("/OutgoingCallerIds.json")) {
          return new Response(JSON.stringify({ outgoing_caller_ids: [] }), {
            status: 200,
          });
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch;

      const result = await provider.checkCallerIdEligibility("+15559999999");
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain("not owned by or verified");
      expect(result.reason).toContain("Twilio Console");
    });

    test("throws when both API calls return non-ok responses", async () => {
      const provider = new TwilioConversationRelayProvider();

      globalThis.fetch = (async (url: RequestInfo | URL): Promise<Response> => {
        const urlStr = String(url);
        if (urlStr.includes("/IncomingPhoneNumbers.json")) {
          return new Response("Internal Server Error", { status: 500 });
        }
        if (urlStr.includes("/OutgoingCallerIds.json")) {
          return new Response("Internal Server Error", { status: 500 });
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch;

      await expect(
        provider.checkCallerIdEligibility("+15550001111"),
      ).rejects.toThrow("Unable to verify caller ID eligibility");
    });

    test("throws when only one API call fails but the other succeeds with no match", async () => {
      const provider = new TwilioConversationRelayProvider();

      globalThis.fetch = (async (url: RequestInfo | URL): Promise<Response> => {
        const urlStr = String(url);
        if (urlStr.includes("/IncomingPhoneNumbers.json")) {
          return new Response("Internal Server Error", { status: 500 });
        }
        if (urlStr.includes("/OutgoingCallerIds.json")) {
          return new Response(JSON.stringify({ outgoing_caller_ids: [] }), {
            status: 200,
          });
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch;

      await expect(
        provider.checkCallerIdEligibility("+15550001111"),
      ).rejects.toThrow("Unable to verify caller ID eligibility");
    });

    test("passes correct phone number as query parameter", async () => {
      const provider = new TwilioConversationRelayProvider();
      const capturedUrls: string[] = [];

      globalThis.fetch = (async (url: RequestInfo | URL): Promise<Response> => {
        capturedUrls.push(String(url));
        const urlStr = String(url);
        if (urlStr.includes("/IncomingPhoneNumbers.json")) {
          return new Response(
            JSON.stringify({ incoming_phone_numbers: [{ sid: "PN1" }] }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ outgoing_caller_ids: [] }), {
          status: 200,
        });
      }) as unknown as typeof fetch;

      await provider.checkCallerIdEligibility("+15550001111");

      expect(capturedUrls[0]).toContain("PhoneNumber=%2B15550001111");
      expect(capturedUrls[0]).toContain("/IncomingPhoneNumbers.json");
    });
  });
});
