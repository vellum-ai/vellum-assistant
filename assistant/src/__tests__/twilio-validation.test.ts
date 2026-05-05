import { beforeEach, describe, expect, mock, test } from "bun:test";

let mockConfig: Record<string, unknown>;
let mockVerifyCalls: Array<{
  url: string;
  params: Record<string, string>;
  signature: string;
  authToken: string;
}> = [];

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  loadConfig: () => mockConfig,
}));

mock.module("../calls/twilio-provider.js", () => ({
  TwilioConversationRelayProvider: class {
    static getAuthToken() {
      return "test-auth-token";
    }

    static verifyWebhookSignature(
      url: string,
      params: Record<string, string>,
      signature: string,
      authToken: string,
    ) {
      mockVerifyCalls.push({ url, params, signature, authToken });
      return signature === "valid";
    }
  },
}));

import { validateTwilioWebhook } from "../runtime/middleware/twilio-validation.js";

describe("Twilio validation middleware", () => {
  beforeEach(() => {
    mockVerifyCalls = [];
    mockConfig = {
      ingress: {
        publicBaseUrl: "https://generic.example.com",
      },
    };
  });

  test("validates signatures against Twilio-specific public ingress first", async () => {
    mockConfig = {
      ingress: {
        publicBaseUrl: "  https://twilio.example.com///  ",
      },
    };
    const req = new Request(
      "http://127.0.0.1:7821/v1/calls/twilio/voice-webhook?callSessionId=session-123",
      {
        method: "POST",
        headers: { "x-twilio-signature": "valid" },
        body: new URLSearchParams({ CallSid: "CA123" }),
      },
    );

    const result = await validateTwilioWebhook(req);

    expect(result).toEqual({ body: "CallSid=CA123" });
    expect(mockVerifyCalls).toEqual([
      {
        url: "https://twilio.example.com/v1/calls/twilio/voice-webhook?callSessionId=session-123",
        params: { CallSid: "CA123" },
        signature: "valid",
        authToken: "test-auth-token",
      },
    ]);
  });

  test("falls back to generic public ingress when Twilio-specific ingress is empty", async () => {
    const req = new Request("http://127.0.0.1:7821/v1/calls/twilio/status", {
      method: "POST",
      headers: { "x-twilio-signature": "valid" },
      body: new URLSearchParams({ CallSid: "CA123" }),
    });

    await validateTwilioWebhook(req);

    expect(mockVerifyCalls[0]?.url).toBe(
      "https://generic.example.com/v1/calls/twilio/status",
    );
  });
});
