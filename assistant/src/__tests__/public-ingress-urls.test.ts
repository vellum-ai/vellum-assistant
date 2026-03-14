import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — silence logger output during tests
// ---------------------------------------------------------------------------

function makeLoggerStub(): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const m of [
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "fatal",
    "silent",
    "child",
  ]) {
    stub[m] = m === "child" ? () => makeLoggerStub() : () => {};
  }
  return stub;
}

mock.module("../util/logger.js", () => ({
  getLogger: () => makeLoggerStub(),
}));

import { setIngressPublicBaseUrl } from "../config/env.js";
import {
  getOAuthCallbackUrl,
  getPublicBaseUrl,
  getTelegramWebhookUrl,
  getTwilioConnectActionUrl,
  getTwilioRelayUrl,
  getTwilioStatusCallbackUrl,
  getTwilioVoiceWebhookUrl,
} from "../inbound/public-ingress-urls.js";

// ---------------------------------------------------------------------------
// getPublicBaseUrl — fallback chain
// ---------------------------------------------------------------------------

describe("getPublicBaseUrl", () => {
  beforeEach(() => {
    setIngressPublicBaseUrl(undefined);
  });

  afterEach(() => {
    setIngressPublicBaseUrl(undefined);
  });

  test("returns ingress.publicBaseUrl when set", () => {
    const result = getPublicBaseUrl({
      ingress: { publicBaseUrl: "https://ingress.example.com/" },
    });
    expect(result).toBe("https://ingress.example.com");
  });

  test("falls back to module-level ingress state when ingress.publicBaseUrl is empty", () => {
    setIngressPublicBaseUrl("https://ingress-env.example.com/");
    const result = getPublicBaseUrl({
      ingress: { publicBaseUrl: "" },
    });
    expect(result).toBe("https://ingress-env.example.com");
  });

  test("falls back to module-level ingress state when config is empty", () => {
    setIngressPublicBaseUrl("https://ingress-env.example.com");
    const result = getPublicBaseUrl({});
    expect(result).toBe("https://ingress-env.example.com");
  });

  test("throws when no source provides a value", () => {
    expect(() =>
      getPublicBaseUrl({
        ingress: { publicBaseUrl: "" },
      }),
    ).toThrow(/No public base URL configured/);
  });

  test("throws when all sources are undefined", () => {
    expect(() => getPublicBaseUrl({})).toThrow(/No public base URL configured/);
  });

  test("throws when ingress is explicitly disabled", () => {
    expect(() =>
      getPublicBaseUrl({
        ingress: { enabled: false, publicBaseUrl: "https://example.com" },
      }),
    ).toThrow(/Public ingress is disabled/);
  });

  test("throws when ingress is explicitly disabled with no URL", () => {
    expect(() =>
      getPublicBaseUrl({
        ingress: { enabled: false, publicBaseUrl: "" },
      }),
    ).toThrow(/Public ingress is disabled/);
  });

  test("returns URL when enabled is undefined", () => {
    const result = getPublicBaseUrl({
      ingress: { enabled: undefined, publicBaseUrl: "https://example.com" },
    });
    expect(result).toBe("https://example.com");
  });

  test("returns URL when enabled is true", () => {
    const result = getPublicBaseUrl({
      ingress: { enabled: true, publicBaseUrl: "https://example.com" },
    });
    expect(result).toBe("https://example.com");
  });

  test("falls back to module-level state when enabled is undefined and no publicBaseUrl", () => {
    setIngressPublicBaseUrl("https://env-fallback.example.com");
    const result = getPublicBaseUrl({
      ingress: { enabled: undefined, publicBaseUrl: "" },
    });
    expect(result).toBe("https://env-fallback.example.com");
  });

  test("normalizes trailing slashes from ingress.publicBaseUrl", () => {
    const result = getPublicBaseUrl({
      ingress: { publicBaseUrl: "https://example.com///" },
    });
    expect(result).toBe("https://example.com");
  });

  test("trims whitespace from ingress.publicBaseUrl", () => {
    const result = getPublicBaseUrl({
      ingress: { publicBaseUrl: "  https://example.com  " },
    });
    expect(result).toBe("https://example.com");
  });

  test("skips whitespace-only ingress.publicBaseUrl and falls through to module state", () => {
    setIngressPublicBaseUrl("https://ingress-env.example.com");
    const result = getPublicBaseUrl({
      ingress: { publicBaseUrl: "   " },
    });
    expect(result).toBe("https://ingress-env.example.com");
  });

  test("normalizes trailing slashes from module-level ingress state", () => {
    setIngressPublicBaseUrl("https://ingress-env.example.com///");
    const result = getPublicBaseUrl({});
    expect(result).toBe("https://ingress-env.example.com");
  });

  test("trims whitespace from module-level ingress state", () => {
    setIngressPublicBaseUrl("  https://ingress-env.example.com  ");
    const result = getPublicBaseUrl({});
    expect(result).toBe("https://ingress-env.example.com");
  });
});

// ---------------------------------------------------------------------------
// getTwilioVoiceWebhookUrl
// ---------------------------------------------------------------------------

describe("getTwilioVoiceWebhookUrl", () => {
  test("builds correct URL with callSessionId", () => {
    const url = getTwilioVoiceWebhookUrl(
      { ingress: { publicBaseUrl: "https://example.com" } },
      "session-123",
    );
    expect(url).toBe(
      "https://example.com/webhooks/twilio/voice?callSessionId=session-123",
    );
  });

  test("normalizes base URL before composing", () => {
    const url = getTwilioVoiceWebhookUrl(
      { ingress: { publicBaseUrl: "https://example.com/" } },
      "abc",
    );
    expect(url).toBe(
      "https://example.com/webhooks/twilio/voice?callSessionId=abc",
    );
  });
});

// ---------------------------------------------------------------------------
// getTwilioStatusCallbackUrl
// ---------------------------------------------------------------------------

describe("getTwilioStatusCallbackUrl", () => {
  test("builds correct URL", () => {
    const url = getTwilioStatusCallbackUrl({
      ingress: { publicBaseUrl: "https://example.com" },
    });
    expect(url).toBe("https://example.com/webhooks/twilio/status");
  });
});

// ---------------------------------------------------------------------------
// getTwilioConnectActionUrl
// ---------------------------------------------------------------------------

describe("getTwilioConnectActionUrl", () => {
  test("builds correct URL", () => {
    const url = getTwilioConnectActionUrl({
      ingress: { publicBaseUrl: "https://example.com" },
    });
    expect(url).toBe("https://example.com/webhooks/twilio/connect-action");
  });
});

// ---------------------------------------------------------------------------
// getTwilioRelayUrl — scheme conversion
// ---------------------------------------------------------------------------

describe("getTwilioRelayUrl", () => {
  test("converts https to wss", () => {
    const url = getTwilioRelayUrl({
      ingress: { publicBaseUrl: "https://example.com" },
    });
    expect(url).toBe("wss://example.com/webhooks/twilio/relay");
  });

  test("converts http to ws", () => {
    const url = getTwilioRelayUrl({
      ingress: { publicBaseUrl: "http://localhost:7821" },
    });
    expect(url).toBe("ws://localhost:7821/webhooks/twilio/relay");
  });

  test("normalizes trailing slash before conversion", () => {
    const url = getTwilioRelayUrl({
      ingress: { publicBaseUrl: "https://example.com/" },
    });
    expect(url).toBe("wss://example.com/webhooks/twilio/relay");
  });
});

// ---------------------------------------------------------------------------
// getOAuthCallbackUrl
// ---------------------------------------------------------------------------

describe("getOAuthCallbackUrl", () => {
  test("builds correct URL", () => {
    const url = getOAuthCallbackUrl({
      ingress: { publicBaseUrl: "https://example.com" },
    });
    expect(url).toBe("https://example.com/webhooks/oauth/callback");
  });
});

// ---------------------------------------------------------------------------
// getTelegramWebhookUrl
// ---------------------------------------------------------------------------

describe("getTelegramWebhookUrl", () => {
  test("builds correct URL", () => {
    const url = getTelegramWebhookUrl({
      ingress: { publicBaseUrl: "https://example.com" },
    });
    expect(url).toBe("https://example.com/webhooks/telegram");
  });

  test("normalizes trailing slash before composing", () => {
    const url = getTelegramWebhookUrl({
      ingress: { publicBaseUrl: "https://example.com/" },
    });
    expect(url).toBe("https://example.com/webhooks/telegram");
  });
});
