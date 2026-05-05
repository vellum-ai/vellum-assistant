/**
 * Unit tests for the Twilio voice webhook gateway handler.
 *
 * Validates that:
 * - Inbound calls (no callSessionId) resolve the assistant by "To" phone number
 *   for gateway routing decisions (reject/default/forward).
 * - When phone-number lookup misses, fallback routing (defaultAssistantId /
 *   unmapped policy) is applied instead of silently forwarding with no assistant.
 * - Outbound calls (callSessionId present) do not resolve or forward an assistantId.
 * - Validation failures are propagated as responses.
 * - Assistant IDs are NOT forwarded to the daemon (daemon uses internal scope).
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { resolvePublicBaseWssUrl } from "../../runtime/client.js";

// ── Mocks ──────────────────────────────────────────────────────────────

let lastForwardedParams: Record<string, string> | undefined;
let _lastForwardedOriginalUrl: string | undefined;
let forwardCalled = false;

mock.module("../../runtime/client.js", () => ({
  forwardTwilioVoiceWebhook: async (
    _config: unknown,
    params: Record<string, string>,
    originalUrl: string,
  ) => {
    lastForwardedParams = params;
    _lastForwardedOriginalUrl = originalUrl;
    forwardCalled = true;
    return {
      status: 200,
      body: "<Response/>",
      headers: { "Content-Type": "text/xml" },
    };
  },
}));

mock.module("../../twilio/validate-webhook.js", () => ({
  validateTwilioWebhookRequest: async (req: Request) => {
    const rawBody = await req.text();
    const formData = new URLSearchParams(rawBody);
    const params: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      params[key] = value;
    }
    return { rawBody, params };
  },
}));

mock.module("../../logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../voice/verification.js", () => ({
  findPendingPhoneSession: async () => null,
  gatherVerificationTwiml: () => "<Response/>",
}));

import { createTwilioVoiceWebhookHandler } from "./twilio-voice-webhook.js";
import type { GatewayConfig } from "../../config.js";
import type { ConfigFileCache } from "../../config-file-cache.js";

// ── Test config ────────────────────────────────────────────────────────

const baseConfig: GatewayConfig = {
  assistantRuntimeBaseUrl: "http://127.0.0.1:7821",
  defaultAssistantId: undefined,
  gatewayInternalBaseUrl: "http://127.0.0.1:7830",
  logFile: { dir: undefined, retentionDays: 30 },
  maxAttachmentBytes: {
    telegram: 50 * 1024 * 1024,
    slack: 100 * 1024 * 1024,
    whatsapp: 16 * 1024 * 1024,
    default: 50 * 1024 * 1024,
  },
  maxAttachmentConcurrency: 3,
  maxWebhookPayloadBytes: 1024 * 1024,
  port: 7830,
  routingEntries: [],
  runtimeInitialBackoffMs: 500,
  runtimeMaxRetries: 2,
  runtimeProxyRequireAuth: true,
  runtimeTimeoutMs: 30000,
  shutdownDrainMs: 5000,
  unmappedPolicy: "reject",
  trustProxy: false,
};

function makeVoiceRequest(
  params: Record<string, string>,
  queryString = "",
): Request {
  const body = new URLSearchParams(params).toString();
  return new Request(
    `http://127.0.0.1:7830/webhooks/twilio/voice${queryString}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );
}

/** Create a mock ConfigFileCache with phone number mappings. */
function makeCachesWithPhoneNumbers(mapping?: Record<string, string>) {
  const phoneNumbers = mapping ?? {
    "assistant-abc": "+15550001111",
    "assistant-xyz": "+15550002222",
  };
  const configFile = {
    getString: () => undefined,
    getRecord: (section: string, key: string) => {
      if (section === "twilio" && key === "assistantPhoneNumbers")
        return phoneNumbers;
      return undefined;
    },
    refreshNow: () => {},
  } as unknown as ConfigFileCache;
  return { configFile };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("twilio voice webhook handler", () => {
  beforeEach(() => {
    lastForwardedParams = undefined;
    _lastForwardedOriginalUrl = undefined;
    forwardCalled = false;
  });

  test("inbound call resolves assistant by To number and forwards to daemon", async () => {
    const handler = createTwilioVoiceWebhookHandler(
      baseConfig,
      makeCachesWithPhoneNumbers(),
    );
    const req = makeVoiceRequest({
      CallSid: "CA_inbound_1",
      From: "+14155551234",
      To: "+15550001111",
    });

    const res = await handler(req);

    expect(res.status).toBe(200);
    // Gateway resolves assistant for routing but does NOT forward assistantId to daemon
    expect(forwardCalled).toBe(true);
    expect(lastForwardedParams?.CallSid).toBe("CA_inbound_1");
  });

  test("inbound call with unknown To number is rejected when unmappedPolicy is reject", async () => {
    const handler = createTwilioVoiceWebhookHandler(
      baseConfig,
      makeCachesWithPhoneNumbers(),
    );
    const req = makeVoiceRequest({
      CallSid: "CA_inbound_2",
      From: "+14155551234",
      To: "+19999999999",
    });

    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<Reject");
    expect(forwardCalled).toBe(false);
  });

  test("inbound call with unknown To number uses defaultAssistantId when unmappedPolicy is default", async () => {
    const configWithDefault: GatewayConfig = {
      ...baseConfig,
      unmappedPolicy: "default",
      defaultAssistantId: "fallback-assistant",
    };
    const handler = createTwilioVoiceWebhookHandler(
      configWithDefault,
      makeCachesWithPhoneNumbers(),
    );
    const req = makeVoiceRequest({
      CallSid: "CA_inbound_fallback",
      From: "+14155551234",
      To: "+19999999999",
    });

    const res = await handler(req);

    expect(res.status).toBe(200);
    // Gateway resolves fallback for routing, forwards call to daemon without assistantId
    expect(forwardCalled).toBe(true);
  });

  test("outbound call (callSessionId present) does not resolve assistant by phone", async () => {
    const handler = createTwilioVoiceWebhookHandler(
      baseConfig,
      makeCachesWithPhoneNumbers(),
    );
    const req = makeVoiceRequest(
      {
        CallSid: "CA_outbound_1",
        From: "+15550001111",
        To: "+14155559999",
      },
      "?callSessionId=existing-session-id",
    );

    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(forwardCalled).toBe(true);
  });

  test("empty callSessionId is treated as inbound (resolves assistant by To number)", async () => {
    const handler = createTwilioVoiceWebhookHandler(
      baseConfig,
      makeCachesWithPhoneNumbers(),
    );
    const req = makeVoiceRequest(
      {
        CallSid: "CA_empty_session",
        From: "+14155551234",
        To: "+15550001111",
      },
      "?callSessionId=",
    );

    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(forwardCalled).toBe(true);
    expect(lastForwardedParams?.CallSid).toBe("CA_empty_session");
  });

  test("inbound call resolves second assistant by To number", async () => {
    const handler = createTwilioVoiceWebhookHandler(
      baseConfig,
      makeCachesWithPhoneNumbers(),
    );
    const req = makeVoiceRequest({
      CallSid: "CA_inbound_3",
      From: "+14155551234",
      To: "+15550002222",
    });

    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(forwardCalled).toBe(true);
  });

  test("inbound call without assistantPhoneNumbers config is rejected when unmappedPolicy is reject", async () => {
    // No configFile cache means no phone number mapping — falls through to unmapped policy.
    const handler = createTwilioVoiceWebhookHandler(baseConfig);
    const req = makeVoiceRequest({
      CallSid: "CA_inbound_4",
      From: "+14155551234",
      To: "+15550001111",
    });

    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<Reject");
    expect(forwardCalled).toBe(false);
  });

  test("inbound call without assistantPhoneNumbers uses defaultAssistantId when unmappedPolicy is default", async () => {
    const configNoMappingWithDefault: GatewayConfig = {
      ...baseConfig,
      unmappedPolicy: "default",
      defaultAssistantId: "fallback-assistant",
    };
    const handler = createTwilioVoiceWebhookHandler(configNoMappingWithDefault);
    const req = makeVoiceRequest({
      CallSid: "CA_inbound_5",
      From: "+14155551234",
      To: "+15550001111",
    });

    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(forwardCalled).toBe(true);
  });
});

// ── resolvePublicBaseWssUrl unit tests ─────────────────────────────────

describe("resolvePublicBaseWssUrl", () => {
  const baseConfig = {
    assistantRuntimeBaseUrl: "http://localhost:3000",
  } as Parameters<typeof resolvePublicBaseWssUrl>[0];

  test("returns undefined when neither velayBaseUrl nor configFile publicBaseUrl is set", () => {
    expect(resolvePublicBaseWssUrl(baseConfig)).toBeUndefined();
  });

  test("uses velayBaseUrl + platformAssistantId when both are present", () => {
    const config = {
      ...baseConfig,
      velayBaseUrl: "https://velay-dev.vellum.ai",
    };
    const result = resolvePublicBaseWssUrl(
      config,
      undefined,
      "abc12345-0000-0000-0000-000000000000",
    );
    expect(result).toBe(
      "wss://velay-dev.vellum.ai/abc12345-0000-0000-0000-000000000000",
    );
  });

  test("falls back to configFile publicBaseUrl when velayBaseUrl is set but platformAssistantId is missing", () => {
    const config = {
      ...baseConfig,
      velayBaseUrl: "https://velay-dev.vellum.ai",
    };
    const mockConfigFile = {
      getString: (section: string, key: string) =>
        section === "ingress" && key === "publicBaseUrl"
          ? "https://velay-dev.vellum.ai/abc12345-0000-0000-0000-000000000000"
          : undefined,
    } as Parameters<typeof resolvePublicBaseWssUrl>[1];
    const result = resolvePublicBaseWssUrl(config, mockConfigFile, undefined);
    expect(result).toBe(
      "wss://velay-dev.vellum.ai/abc12345-0000-0000-0000-000000000000",
    );
  });

  test("strips trailing slash from velayBaseUrl before joining assistant ID", () => {
    const config = {
      ...baseConfig,
      velayBaseUrl: "https://velay-dev.vellum.ai/",
    };
    const result = resolvePublicBaseWssUrl(
      config,
      undefined,
      "abc12345-0000-0000-0000-000000000000",
    );
    expect(result).toBe(
      "wss://velay-dev.vellum.ai/abc12345-0000-0000-0000-000000000000",
    );
  });
});
