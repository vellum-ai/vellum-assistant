import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  createTestHandlerContext,
  noopLogger,
} from "./handlers/handler-test-helpers.js";

// ── Mock state ──────────────────────────────────────────────────────────────

let rawConfig: Record<string, unknown> = {};
const mockSaveRawConfig = mock((raw: Record<string, unknown>) => {
  rawConfig = structuredClone(raw);
});
const mockSetIngressPublicBaseUrl = mock();
const mockHasTwilioCredentials = mock(async () => false);
const mockGetTwilioCredentials = mock(async () => ({
  accountSid: "AC-test",
  authToken: "auth-test",
}));
const mockUpdatePhoneNumberWebhooks = mock(async () => {});
const mockShouldUsePlatformCallbacks = mock(() => false);
const mockRegisterCallbackRoute = mock(
  () => Promise.resolve() as Promise<void>,
);
const mockResolveCallbackUrl = mock(
  async (_fallback: () => string, _path: string, _key: string) =>
    "https://resolved.example.com/webhooks/twilio/voice",
);
const mockGetTwilioVoiceWebhookUrl = mock(
  () => "https://pub.example.com/webhooks/twilio/voice",
);
const mockGetTwilioStatusCallbackUrl = mock(
  () => "https://pub.example.com/webhooks/twilio/status",
);

// ── Mocks (before any handler imports) ──────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () => noopLogger,
}));

mock.module("../config/loader.js", () => ({
  loadRawConfig: () => structuredClone(rawConfig),
  saveRawConfig: mockSaveRawConfig,
}));

mock.module("../config/env.js", () => ({
  getGatewayInternalBaseUrl: () => "http://localhost:7830",
  setIngressPublicBaseUrl: mockSetIngressPublicBaseUrl,
}));

mock.module("../calls/twilio-rest.js", () => ({
  getTwilioCredentials: mockGetTwilioCredentials,
  hasTwilioCredentials: mockHasTwilioCredentials,
  updatePhoneNumberWebhooks: mockUpdatePhoneNumberWebhooks,
}));

mock.module("../inbound/platform-callback-registration.js", () => ({
  registerCallbackRoute: mockRegisterCallbackRoute,
  resolveCallbackUrl: mockResolveCallbackUrl,
  shouldUsePlatformCallbacks: mockShouldUsePlatformCallbacks,
}));

mock.module("../inbound/public-ingress-urls.js", () => ({
  getTwilioVoiceWebhookUrl: mockGetTwilioVoiceWebhookUrl,
  getTwilioStatusCallbackUrl: mockGetTwilioStatusCallbackUrl,
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import {
  computeGatewayTarget,
  getIngressConfigResult,
  handleIngressConfig,
  syncTwilioWebhooks,
} from "../daemon/handlers/config-ingress.js";

// ── Tests ───────────────────────────────────────────────────────────────────

describe("computeGatewayTarget", () => {
  test("returns gateway base URL from env", () => {
    expect(computeGatewayTarget()).toBe("http://localhost:7830");
  });
});

describe("getIngressConfigResult", () => {
  beforeEach(() => {
    rawConfig = {};
  });

  test("returns enabled config with URL", () => {
    rawConfig = {
      ingress: { enabled: true, publicBaseUrl: "https://pub.example.com" },
    };

    const result = getIngressConfigResult();

    expect(result.enabled).toBe(true);
    expect(result.publicBaseUrl).toBe("https://pub.example.com");
    expect(result.localGatewayTarget).toBe("http://localhost:7830");
    expect(result.success).toBe(true);
  });

  test("returns disabled when not configured", () => {
    rawConfig = {};

    const result = getIngressConfigResult();

    expect(result.enabled).toBe(false);
    expect(result.publicBaseUrl).toBe("");
    expect(result.success).toBe(true);
  });
});

describe("syncTwilioWebhooks", () => {
  beforeEach(() => {
    mockUpdatePhoneNumberWebhooks.mockReset();
    mockResolveCallbackUrl.mockReset();
    mockResolveCallbackUrl.mockResolvedValue(
      "https://resolved.example.com/webhooks/twilio/voice",
    );
  });

  test("success returns { success: true }", async () => {
    mockUpdatePhoneNumberWebhooks.mockResolvedValue(undefined);

    const result = await syncTwilioWebhooks(
      "+15551234567",
      "AC-test",
      "auth-test",
      { ingress: { enabled: true, publicBaseUrl: "https://pub.example.com" } },
    );

    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  test("failure returns { success: false, warning }", async () => {
    mockUpdatePhoneNumberWebhooks.mockRejectedValue(
      new Error("Twilio API error"),
    );

    const result = await syncTwilioWebhooks(
      "+15551234567",
      "AC-test",
      "auth-test",
      { ingress: { enabled: true, publicBaseUrl: "https://pub.example.com" } },
    );

    expect(result.success).toBe(false);
    expect(result.warning).toContain("Webhook configuration skipped");
  });
});

describe("handleIngressConfig", () => {
  beforeEach(() => {
    rawConfig = {};
    mockSaveRawConfig.mockReset();
    mockSaveRawConfig.mockImplementation((raw: Record<string, unknown>) => {
      rawConfig = structuredClone(raw);
    });
    mockSetIngressPublicBaseUrl.mockReset();
    mockHasTwilioCredentials.mockReset();
    mockHasTwilioCredentials.mockResolvedValue(false);
    mockShouldUsePlatformCallbacks.mockReturnValue(false);
    mockRegisterCallbackRoute.mockReset();
    mockRegisterCallbackRoute.mockReturnValue(Promise.resolve());
    mockUpdatePhoneNumberWebhooks.mockReset();
    mockGetTwilioCredentials.mockReset();
    mockGetTwilioCredentials.mockResolvedValue({
      accountSid: "AC-test",
      authToken: "auth-test",
    });
    mockResolveCallbackUrl.mockReset();
    mockResolveCallbackUrl.mockResolvedValue(
      "https://resolved.example.com/webhooks/twilio/voice",
    );
  });

  test("GET action sends current config", async () => {
    rawConfig = {
      ingress: { enabled: true, publicBaseUrl: "https://pub.example.com" },
    };
    const { ctx, sent } = createTestHandlerContext();

    await handleIngressConfig({ type: "ingress_config", action: "get" }, ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("ingress_config_response");
    expect(sent[0].success).toBe(true);
    expect(sent[0].enabled).toBe(true);
    expect(sent[0].publicBaseUrl).toBe("https://pub.example.com");
  });

  test("SET with URL and enabled saves config and sets module-level URL", async () => {
    const { ctx, sent } = createTestHandlerContext();

    await handleIngressConfig(
      {
        type: "ingress_config",
        action: "set",
        publicBaseUrl: "https://new.example.com",
        enabled: true,
      },
      ctx,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("ingress_config_response");
    expect(sent[0].success).toBe(true);
    expect(sent[0].publicBaseUrl).toBe("https://new.example.com");
    expect(sent[0].enabled).toBe(true);
    expect(mockSaveRawConfig).toHaveBeenCalledTimes(1);
    expect(mockSetIngressPublicBaseUrl).toHaveBeenCalledWith(
      "https://new.example.com",
    );
  });

  test("SET with disabled clears module-level URL", async () => {
    const { ctx } = createTestHandlerContext();

    await handleIngressConfig(
      {
        type: "ingress_config",
        action: "set",
        publicBaseUrl: "https://new.example.com",
        enabled: false,
      },
      ctx,
    );

    expect(mockSetIngressPublicBaseUrl).toHaveBeenCalledWith(undefined);
  });

  test("SET with empty URL clears publicBaseUrl", async () => {
    const { ctx, sent } = createTestHandlerContext();

    await handleIngressConfig(
      {
        type: "ingress_config",
        action: "set",
        publicBaseUrl: "",
        enabled: true,
      },
      ctx,
    );

    expect(sent[0].publicBaseUrl).toBe("");
    // Empty URL with enabled → setIngressPublicBaseUrl(undefined) because value is falsy
    expect(mockSetIngressPublicBaseUrl).toHaveBeenCalledWith(undefined);
  });

  test("SET triggers Telegram callback when containerized", async () => {
    mockShouldUsePlatformCallbacks.mockReturnValue(true);
    const { ctx } = createTestHandlerContext();

    await handleIngressConfig(
      {
        type: "ingress_config",
        action: "set",
        publicBaseUrl: "https://x.com",
        enabled: true,
      },
      ctx,
    );

    expect(mockRegisterCallbackRoute).toHaveBeenCalledWith(
      "webhooks/telegram",
      "telegram",
    );
  });

  test("SET reconciles Twilio webhooks when enabled + credentials exist", async () => {
    mockHasTwilioCredentials.mockResolvedValue(true);
    rawConfig = {
      twilio: { phoneNumber: "+15551234567" },
    };
    const { ctx } = createTestHandlerContext();

    await handleIngressConfig(
      {
        type: "ingress_config",
        action: "set",
        publicBaseUrl: "https://new.example.com",
        enabled: true,
      },
      ctx,
    );

    // syncTwilioWebhooks is fire-and-forget but we can check resolveCallbackUrl was called
    // Wait briefly for the fire-and-forget to execute
    await new Promise((r) => setTimeout(r, 50));
    expect(mockResolveCallbackUrl).toHaveBeenCalled();
  });

  test("SET without Twilio creds skips reconciliation", async () => {
    mockHasTwilioCredentials.mockResolvedValue(false);
    const { ctx } = createTestHandlerContext();

    await handleIngressConfig(
      {
        type: "ingress_config",
        action: "set",
        publicBaseUrl: "https://x.com",
        enabled: true,
      },
      ctx,
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(mockResolveCallbackUrl).not.toHaveBeenCalled();
  });

  test("SET with multiple assigned numbers reconciles all", async () => {
    mockHasTwilioCredentials.mockResolvedValue(true);
    mockUpdatePhoneNumberWebhooks.mockResolvedValue(undefined);
    rawConfig = {
      twilio: {
        phoneNumber: "+15551111111",
        assistantPhoneNumbers: {
          main: "+15552222222",
          backup: "+15553333333",
        },
      },
    };
    const { ctx } = createTestHandlerContext();

    await handleIngressConfig(
      {
        type: "ingress_config",
        action: "set",
        publicBaseUrl: "https://x.com",
        enabled: true,
      },
      ctx,
    );

    // Wait for fire-and-forget
    await new Promise((r) => setTimeout(r, 100));
    // resolveCallbackUrl is called once per syncTwilioWebhooks call (which has 2 resolve calls each)
    // and there are 3 unique numbers, so at least 3 calls
    expect(mockResolveCallbackUrl.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  test("unknown action sends error", async () => {
    const { ctx, sent } = createTestHandlerContext();

    await handleIngressConfig(
      { type: "ingress_config", action: "delete" as any },
      ctx,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("ingress_config_response");
    expect(sent[0].success).toBe(false);
    expect(sent[0].error).toContain("Unknown action");
  });
});
