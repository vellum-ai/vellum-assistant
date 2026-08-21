import { describe, expect, test } from "bun:test";

import {
  normalizeHttpPublicBaseUrl,
  normalizeHttpPublicBaseUrlWithoutTrailingSlash,
  normalizePublicBaseUrl,
  parseRecordedAssistantId,
  parseTunnelRecord,
  trimmedNonEmptyString,
  TUNNEL_PROVIDERS,
  velayHostForPlatformHost,
} from "../ingress.js";
import {
  buildTwilioMediaStreamUrl,
  buildTwilioPhoneNumberWebhookUrls,
  buildTwilioVoiceWebhookUrl,
  resolveTwilioPublicBaseUrl,
} from "../twilio-ingress.js";

describe("velayHostForPlatformHost", () => {
  test("maps the prod platform host to prod velay", () => {
    expect(velayHostForPlatformHost("platform.vellum.ai")).toBe(
      "velay.vellum.ai",
    );
  });

  test("maps env-prefixed platform hosts to their env velay", () => {
    expect(velayHostForPlatformHost("staging-platform.vellum.ai")).toBe(
      "velay-staging.vellum.ai",
    );
    expect(velayHostForPlatformHost("dev-platform.vellum.ai")).toBe(
      "velay-dev.vellum.ai",
    );
  });

  test("returns null for hosts outside the deployment convention", () => {
    expect(velayHostForPlatformHost("localhost")).toBeNull();
    expect(velayHostForPlatformHost("platform.example.com")).toBeNull();
    expect(
      velayHostForPlatformHost("staging-platform.vellum.ai.evil.com"),
    ).toBeNull();
  });
});

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

describe("normalizeHttpPublicBaseUrlWithoutTrailingSlash", () => {
  test("drops the root path its sibling always emits", () => {
    expect(
      normalizeHttpPublicBaseUrlWithoutTrailingSlash("https://x.test"),
    ).toBe("https://x.test");
    expect(
      normalizeHttpPublicBaseUrlWithoutTrailingSlash("https://x.test/"),
    ).toBe("https://x.test");
    expect(
      normalizeHttpPublicBaseUrlWithoutTrailingSlash(" https://x.test/api/// "),
    ).toBe("https://x.test/api");
  });

  test("rejects everything its sibling rejects", () => {
    for (const value of [
      "",
      "   ",
      "notaurl",
      "ftp://x.test",
      "https://x.test?a=b",
      42,
    ]) {
      expect(
        normalizeHttpPublicBaseUrlWithoutTrailingSlash(value),
      ).toBeUndefined();
    }
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
    expect(buildTwilioMediaStreamUrl("http://example.test")).toBe(
      "ws://example.test/webhooks/twilio/media-stream",
    );
    expect(buildTwilioPhoneNumberWebhookUrls("https://example.test")).toEqual({
      statusCallbackUrl: "https://example.test/webhooks/twilio/status",
      voiceUrl: "https://example.test/webhooks/twilio/voice",
    });
  });
});

describe("parseTunnelRecord", () => {
  const TUNNEL_URL = "https://assistant-1.example.ts.net";

  test("accepts every provider in the registry", () => {
    for (const provider of TUNNEL_PROVIDERS) {
      expect(
        parseTunnelRecord({ provider, publicBaseUrl: TUNNEL_URL }),
      ).toEqual({ provider, publicBaseUrl: TUNNEL_URL });
    }
  });

  test("returns the URL in the shape its own validator produces", () => {
    // Padding and trailing slashes are normalized away rather than handed
    // back, so readers never re-normalize what they were given.
    for (const publicBaseUrl of [
      ` ${TUNNEL_URL} `,
      `${TUNNEL_URL}/`,
      `${TUNNEL_URL}///`,
    ]) {
      expect(
        parseTunnelRecord({ provider: "ngrok", publicBaseUrl }),
      ).toEqual({ provider: "ngrok", publicBaseUrl: TUNNEL_URL });
    }
  });

  test("rejects values that are not a record", () => {
    for (const value of [undefined, null, "nonsense", 42, []]) {
      expect(parseTunnelRecord(value)).toBeNull();
    }
  });

  test("rejects a record missing either field", () => {
    expect(parseTunnelRecord({ provider: "ngrok" })).toBeNull();
    expect(parseTunnelRecord({ publicBaseUrl: TUNNEL_URL })).toBeNull();
  });

  test("rejects a provider outside the registry", () => {
    // Readers render the provider into a `vellum tunnel --provider <name>`
    // command, so a hand-edited config must not reach a terminal.
    for (const provider of ["wireguard", "; rm -rf /", "", 42]) {
      expect(
        parseTunnelRecord({ provider, publicBaseUrl: TUNNEL_URL }),
      ).toBeNull();
    }
  });

  test("rejects a URL that is not absolute HTTP(S)", () => {
    for (const publicBaseUrl of [
      "",
      "   ",
      "not-a-url",
      "example.ts.net",
      "ftp://x.test",
      "https://one.ngrok.app?token=x",
      42,
    ]) {
      expect(
        parseTunnelRecord({ provider: "ngrok", publicBaseUrl }),
      ).toBeNull();
    }
  });
});

describe("trimmedNonEmptyString", () => {
  test("trims and rejects blank or non-string values", () => {
    expect(trimmedNonEmptyString(" assistant-1 ")).toBe("assistant-1");
    for (const value of ["", "   ", undefined, null, 42]) {
      expect(trimmedNonEmptyString(value)).toBeUndefined();
    }
  });
});

describe("parseRecordedAssistantId", () => {
  test("trims a recorded id", () => {
    expect(parseRecordedAssistantId(" assistant-1 ")).toBe("assistant-1");
  });

  test("rejects blank and non-string values", () => {
    for (const value of ["", "   ", undefined, null, 42]) {
      expect(parseRecordedAssistantId(value)).toBeNull();
    }
  });
});
