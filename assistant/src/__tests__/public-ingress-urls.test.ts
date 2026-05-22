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

import {
  setIngressPublicBaseUrl,
  setPlatformAssistantId,
} from "../config/env.js";
import { IngressConfigSchema } from "../config/schemas/ingress.js";
import {
  getOAuthCallbackUrl,
  getPlatformPublicCallbackBase,
  getPublicBaseUrl,
  getTelegramWebhookUrl,
  getTwilioConnectActionUrl,
  getTwilioMediaStreamUrl,
  getTwilioRelayUrl,
  getTwilioStatusCallbackUrl,
  getTwilioVoiceWebhookUrl,
} from "../inbound/public-ingress-urls.js";

// ---------------------------------------------------------------------------
// getPlatformPublicCallbackBase
// ---------------------------------------------------------------------------

describe("getPlatformPublicCallbackBase", () => {
  afterEach(() => {
    delete process.env.IS_PLATFORM;
    delete process.env.VELLUM_PLATFORM_URL;
    setPlatformAssistantId(undefined);
  });

  test("returns the correct URL when IS_PLATFORM=true with valid platform URL and assistant ID", () => {
    process.env.IS_PLATFORM = "true";
    process.env.VELLUM_PLATFORM_URL = "https://test-platform.vellum.ai";
    setPlatformAssistantId("ast_test123");

    const result = getPlatformPublicCallbackBase();
    expect(result).toBe(
      "https://test-platform.vellum.ai/v1/gateway/callbacks/ast_test123",
    );
  });

  test("returns undefined when IS_PLATFORM is not set", () => {
    delete process.env.IS_PLATFORM;
    process.env.VELLUM_PLATFORM_URL = "https://test-platform.vellum.ai";
    setPlatformAssistantId("ast_test123");

    expect(getPlatformPublicCallbackBase()).toBeUndefined();
  });

  test("returns undefined when assistant ID is empty", () => {
    process.env.IS_PLATFORM = "true";
    process.env.VELLUM_PLATFORM_URL = "https://test-platform.vellum.ai";
    setPlatformAssistantId("");

    expect(getPlatformPublicCallbackBase()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// platform fallback in getPublicBaseUrl
// ---------------------------------------------------------------------------

describe("platform fallback", () => {
  beforeEach(() => {
    process.env.IS_PLATFORM = "true";
    process.env.VELLUM_PLATFORM_URL = "https://test-platform.vellum.ai";
    setPlatformAssistantId("ast_test123");
    setIngressPublicBaseUrl(undefined);
  });

  afterEach(() => {
    delete process.env.IS_PLATFORM;
    delete process.env.VELLUM_PLATFORM_URL;
    setPlatformAssistantId(undefined);
    setIngressPublicBaseUrl(undefined);
  });

  test("getPublicBaseUrl returns platform-derived URL when ingress.publicBaseUrl is empty", () => {
    const result = getPublicBaseUrl({
      ingress: { publicBaseUrl: "" },
    });
    expect(result).toBe(
      "https://test-platform.vellum.ai/v1/gateway/callbacks/ast_test123",
    );
  });

  test("explicit ingress.publicBaseUrl takes precedence over platform derivation", () => {
    const result = getPublicBaseUrl({
      ingress: { publicBaseUrl: "https://custom.example.com" },
    });
    expect(result).toBe("https://custom.example.com");
  });

  test("module-level ingress state takes precedence over platform derivation", () => {
    setIngressPublicBaseUrl("https://tunnel.example.com");
    const result = getPublicBaseUrl({
      ingress: { publicBaseUrl: "" },
    });
    expect(result).toBe("https://tunnel.example.com");
  });

  test("throws when ingress is explicitly disabled even in platform mode", () => {
    expect(() =>
      getPublicBaseUrl({
        ingress: { enabled: false, publicBaseUrl: "" },
      }),
    ).toThrow(/Public ingress is disabled/);
  });

  test("throws when IS_PLATFORM is not set", () => {
    delete process.env.IS_PLATFORM;
    setPlatformAssistantId(undefined);

    expect(() => getPublicBaseUrl({ ingress: { publicBaseUrl: "" } })).toThrow(
      /No public base URL configured/,
    );
  });

  test("throws when getPlatformAssistantId() returns empty string even though IS_PLATFORM=true", () => {
    process.env.IS_PLATFORM = "true";
    setPlatformAssistantId("");

    expect(() => getPublicBaseUrl({ ingress: { publicBaseUrl: "" } })).toThrow(
      /No public base URL configured/,
    );
  });
});

// ---------------------------------------------------------------------------
// IngressConfigSchema
// ---------------------------------------------------------------------------

describe("IngressConfigSchema", () => {
  test("accepts an absolute HTTP(S) public base URL", () => {
    const result = IngressConfigSchema.parse({
      publicBaseUrl: "https://example.com",
    });

    expect(result.publicBaseUrl).toBe("https://example.com");
  });

  test("accepts an empty public base URL", () => {
    const result = IngressConfigSchema.parse({
      publicBaseUrl: "",
    });

    expect(result.publicBaseUrl).toBe("");
  });

  test("rejects a relative public base URL", () => {
    expect(() =>
      IngressConfigSchema.parse({
        publicBaseUrl: "/webhooks/twilio",
      }),
    ).toThrow(/ingress\.publicBaseUrl must be an absolute URL/);
  });
});

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
// Twilio-specific public base URL selection
// ---------------------------------------------------------------------------

describe("Twilio URL builders use publicBaseUrl", () => {
  beforeEach(() => {
    setIngressPublicBaseUrl(undefined);
  });

  afterEach(() => {
    setIngressPublicBaseUrl(undefined);
  });

  test("Twilio URL builders use ingress.publicBaseUrl", () => {
    const config = {
      ingress: {
        publicBaseUrl: "  https://example.com///  ",
      },
    };

    expect(getTwilioVoiceWebhookUrl(config, "session-123")).toBe(
      "https://example.com/webhooks/twilio/voice?callSessionId=session-123",
    );
    expect(getTwilioStatusCallbackUrl(config)).toBe(
      "https://example.com/webhooks/twilio/status",
    );
    expect(getTwilioConnectActionUrl(config)).toBe(
      "https://example.com/webhooks/twilio/connect-action",
    );
    expect(getTwilioRelayUrl(config)).toBe(
      "wss://example.com/webhooks/twilio/relay",
    );
    expect(getTwilioMediaStreamUrl(config)).toBe(
      "wss://example.com/webhooks/twilio/media-stream",
    );
  });

  test("Twilio URL builders fall back to module-level ingress state", () => {
    setIngressPublicBaseUrl("https://ingress-env.example.com");

    expect(
      getTwilioStatusCallbackUrl({
        ingress: { publicBaseUrl: "" },
      }),
    ).toBe("https://ingress-env.example.com/webhooks/twilio/status");
  });

  test("all URL builders share the same publicBaseUrl", () => {
    const config = {
      ingress: {
        publicBaseUrl: "https://example.com",
      },
    };

    expect(getPublicBaseUrl(config)).toBe("https://example.com");
    expect(getOAuthCallbackUrl(config)).toBe(
      "https://example.com/webhooks/oauth/callback",
    );
    expect(getTelegramWebhookUrl(config)).toBe(
      "https://example.com/webhooks/telegram",
    );
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
