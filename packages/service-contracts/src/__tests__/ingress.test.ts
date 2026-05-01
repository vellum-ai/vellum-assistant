import { describe, expect, test } from "bun:test";

import {
  normalizeHttpPublicBaseUrl,
  normalizePublicBaseUrl,
} from "../ingress.js";
import {
  buildTwilioConnectActionUrl,
  buildTwilioMediaStreamUrl,
  buildTwilioPhoneNumberWebhookUrls,
  buildTwilioRelayUrl,
  buildTwilioVoiceWebhookUrl,
  resolveTwilioPublicBaseUrl,
} from "../twilio-ingress.js";

describe("normalizePublicBaseUrl", () => {
  test("trims whitespace and trailing slashes", () => {
    expect(normalizePublicBaseUrl(" https://example.test/path/// ")).toBe(
      "https://example.test/path",
    );
  });

  test("rejects non-string and empty values", () => {
    expect(normalizePublicBaseUrl(undefined)).toBeUndefined();
    expect(normalizePublicBaseUrl("   ")).toBeUndefined();
  });
});

describe("normalizeHttpPublicBaseUrl", () => {
  test("normalizes valid HTTP and HTTPS URLs", () => {
    expect(normalizeHttpPublicBaseUrl(" HTTPS://EXAMPLE.TEST/twilio ")).toBe(
      "https://example.test/twilio",
    );
    expect(normalizeHttpPublicBaseUrl("https://example.test/twilio///")).toBe(
      "https://example.test/twilio",
    );
    expect(normalizeHttpPublicBaseUrl("https://example.test")).toBe(
      "https://example.test/",
    );
  });

  test("rejects non-HTTP URLs and malformed values", () => {
    expect(normalizeHttpPublicBaseUrl("ftp://example.test")).toBeUndefined();
    expect(normalizeHttpPublicBaseUrl("notaurl")).toBeUndefined();
    expect(normalizeHttpPublicBaseUrl("")).toBeUndefined();
  });

  test("rejects query strings and fragments instead of mutating them", () => {
    expect(
      normalizeHttpPublicBaseUrl("https://example.test/twilio?token=abc/"),
    ).toBeUndefined();
    expect(
      normalizeHttpPublicBaseUrl("https://example.test/twilio#section/"),
    ).toBeUndefined();
    expect(
      normalizeHttpPublicBaseUrl("https://example.test/twilio?"),
    ).toBeUndefined();
    expect(
      normalizeHttpPublicBaseUrl("https://example.test/twilio#"),
    ).toBeUndefined();
  });
});

describe("Twilio ingress helpers", () => {
  test("resolves public base URL with fallback", () => {
    expect(
      resolveTwilioPublicBaseUrl({
        publicBaseUrl: " https://twilio.example.test/twilio/ ",
      }),
    ).toBe("https://twilio.example.test/twilio");
    expect(
      resolveTwilioPublicBaseUrl({
        publicBaseUrl: " ",
      }),
    ).toBeUndefined();
    expect(
      resolveTwilioPublicBaseUrl({
        publicBaseUrl: " ",
      }, "https://fallback.example.test/"),
    ).toBe("https://fallback.example.test");
    expect(
      resolveTwilioPublicBaseUrl({}, "https://fallback.example.test/"),
    ).toBe("https://fallback.example.test");
  });

  test("builds Twilio webhook and WebSocket URLs from one base URL", () => {
    expect(buildTwilioVoiceWebhookUrl("https://example.test")).toBe(
      "https://example.test/webhooks/twilio/voice",
    );
    expect(buildTwilioVoiceWebhookUrl("https://example.test", "call-123")).toBe(
      "https://example.test/webhooks/twilio/voice?callSessionId=call-123",
    );
    expect(buildTwilioConnectActionUrl("https://example.test")).toBe(
      "https://example.test/webhooks/twilio/connect-action",
    );
    expect(buildTwilioRelayUrl("https://example.test")).toBe(
      "wss://example.test/webhooks/twilio/relay",
    );
    expect(buildTwilioMediaStreamUrl("http://example.test")).toBe(
      "ws://example.test/webhooks/twilio/media-stream",
    );
    expect(buildTwilioPhoneNumberWebhookUrls("https://example.test")).toEqual({
      statusCallbackUrl: "https://example.test/webhooks/twilio/status",
      voiceUrl: "https://example.test/webhooks/twilio/voice",
    });
  });
});
