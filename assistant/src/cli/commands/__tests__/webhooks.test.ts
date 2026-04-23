import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockShouldUsePlatformCallbacks = false;
let mockRegisterCallbackRoute: (
  path: string,
  type: string,
) => Promise<string> = async () => "";
let mockPublicBaseUrl: string | null = null;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../inbound/platform-callback-registration.js", () => ({
  shouldUsePlatformCallbacks: () => mockShouldUsePlatformCallbacks,
  registerCallbackRoute: (path: string, type: string) =>
    mockRegisterCallbackRoute(path, type),
  resolvePlatformCallbackRegistrationContext: async () => ({
    isPlatform: false,
    platformBaseUrl: "",
    assistantId: "",
    hasInternalApiKey: false,
    hasAssistantApiKey: false,
    authHeader: null,
    enabled: false,
  }),
  resolveCallbackUrl: async () => "",
}));

mock.module("../../lib/daemon-credential-client.js", () => ({
  getSecureKeyViaDaemon: async () => undefined,
  deleteSecureKeyViaDaemon: async () => "not-found" as const,
  setSecureKeyViaDaemon: async () => false,
  getSecureKeyResultViaDaemon: async () => ({
    value: undefined,
    unreachable: false,
  }),
}));

const realLogger = await import("../../../util/logger.js");
mock.module("../../../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getCliLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

const realConfigLoader = await import("../../../config/loader.js");
mock.module("../../../config/loader.js", () => ({
  ...realConfigLoader,
  getConfig: () => ({
    ingress: mockPublicBaseUrl
      ? { publicBaseUrl: mockPublicBaseUrl }
      : undefined,
    permissions: { mode: "workspace" },
    skills: { load: { extraDirs: [] } },
    sandbox: { enabled: true },
  }),
  getConfigReadOnly: () => ({
    ingress: mockPublicBaseUrl
      ? { publicBaseUrl: mockPublicBaseUrl }
      : undefined,
    permissions: { mode: "workspace" },
    skills: { load: { extraDirs: [] } },
    sandbox: { enabled: true },
  }),
  loadConfig: () => ({}),
  invalidateConfigCache: () => {},
  saveConfig: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
}));

const realIngressUrls = await import("../../../inbound/public-ingress-urls.js");
mock.module("../../../inbound/public-ingress-urls.js", () => ({
  ...realIngressUrls,
  getPublicBaseUrl: (config: { ingress?: { publicBaseUrl?: string } }) => {
    const url = config.ingress?.publicBaseUrl;
    if (!url) throw new Error("No public base URL configured");
    return url;
  },
}));

// ---------------------------------------------------------------------------
// Import shared test utility (after mocks are registered)
// ---------------------------------------------------------------------------

const { runAssistantCommandFull } =
  await import("../../__tests__/run-assistant-command.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJson(stdout: string): Record<string, unknown> {
  const match = stdout.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON found in stdout: ${stdout}`);
  return JSON.parse(match[0]) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assistant webhooks register", () => {
  beforeEach(() => {
    mockShouldUsePlatformCallbacks = false;
    mockRegisterCallbackRoute = async () => "";
    mockPublicBaseUrl = null;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  describe("platform mode", () => {
    test("registers callback route and returns platform URL", async () => {
      mockShouldUsePlatformCallbacks = true;
      mockRegisterCallbackRoute = async (path, type) => {
        expect(path).toBe("webhooks/telegram");
        expect(type).toBe("telegram");
        return "https://callbacks.vellum.app/a/asst_123/webhooks/telegram";
      };

      const { stdout } = await runAssistantCommandFull(
        "webhooks",
        "register",
        "telegram",
        "--json",
      );

      const result = parseJson(stdout);
      expect(result.ok).toBe(true);
      expect(result.callbackUrl).toBe(
        "https://callbacks.vellum.app/a/asst_123/webhooks/telegram",
      );
      expect(result.mode).toBe("platform");
      expect(result.type).toBe("telegram");
      expect(result.path).toBe("webhooks/telegram");
    });

    test("derives twilio_voice path correctly", async () => {
      mockShouldUsePlatformCallbacks = true;
      mockRegisterCallbackRoute = async (path, type) => {
        expect(path).toBe("webhooks/twilio/voice");
        expect(type).toBe("twilio_voice");
        return "https://callbacks.vellum.app/a/asst_123/webhooks/twilio/voice";
      };

      const { stdout } = await runAssistantCommandFull(
        "webhooks",
        "register",
        "twilio_voice",
        "--json",
      );

      const result = parseJson(stdout);
      expect(result.ok).toBe(true);
      expect(result.callbackUrl).toBe(
        "https://callbacks.vellum.app/a/asst_123/webhooks/twilio/voice",
      );
    });

    test("handles platform registration failure", async () => {
      mockShouldUsePlatformCallbacks = true;
      mockRegisterCallbackRoute = async () => {
        throw new Error("Platform unreachable");
      };

      const { stdout } = await runAssistantCommandFull(
        "webhooks",
        "register",
        "telegram",
        "--json",
      );

      const result = parseJson(stdout);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Platform unreachable");
    });
  });

  describe("self-hosted mode", () => {
    test("builds URL from ingress.publicBaseUrl", async () => {
      mockShouldUsePlatformCallbacks = false;
      mockPublicBaseUrl = "https://abc123.ngrok-free.app";

      const { stdout } = await runAssistantCommandFull(
        "webhooks",
        "register",
        "telegram",
        "--json",
      );

      const result = parseJson(stdout);
      expect(result.ok).toBe(true);
      expect(result.callbackUrl).toBe(
        "https://abc123.ngrok-free.app/webhooks/telegram",
      );
      expect(result.mode).toBe("self-hosted");
    });

    test("fails when no public base URL is configured", async () => {
      mockShouldUsePlatformCallbacks = false;
      mockPublicBaseUrl = null;

      const { stdout } = await runAssistantCommandFull(
        "webhooks",
        "register",
        "resend",
        "--json",
      );

      const result = parseJson(stdout);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("No public base URL configured");
    });
  });

  describe("non-JSON mode emits raw URL", () => {
    test("outputs only the callback URL for shell capture", async () => {
      mockShouldUsePlatformCallbacks = false;
      mockPublicBaseUrl = "https://abc123.ngrok-free.app";

      const { stdout } = await runAssistantCommandFull(
        "webhooks",
        "register",
        "telegram",
      );

      // Should be just the URL with a newline, no JSON wrapper
      expect(stdout.trim()).toBe(
        "https://abc123.ngrok-free.app/webhooks/telegram",
      );
    });
  });

  describe("path derivation", () => {
    const cases = [
      ["telegram", "webhooks/telegram"],
      ["twilio_voice", "webhooks/twilio/voice"],
      ["twilio_status", "webhooks/twilio/status"],
      ["resend", "webhooks/resend"],
      ["mailgun", "webhooks/mailgun"],
      ["email", "webhooks/email"],
      ["oauth_callback", "webhooks/oauth/callback"],
    ] as const;

    for (const [type, expectedPath] of cases) {
      test(`${type} → ${expectedPath}`, async () => {
        mockShouldUsePlatformCallbacks = false;
        mockPublicBaseUrl = "https://test.ngrok-free.app";

        const { stdout } = await runAssistantCommandFull(
          "webhooks",
          "register",
          type,
          "--json",
        );

        const result = parseJson(stdout);
        expect(result.ok).toBe(true);
        expect(result.path).toBe(expectedPath);
        expect(result.callbackUrl).toBe(
          `https://test.ngrok-free.app/${expectedPath}`,
        );
      });
    }
  });

  describe("--path override", () => {
    test("overrides the derived path", async () => {
      mockShouldUsePlatformCallbacks = false;
      mockPublicBaseUrl = "https://tunnel.ngrok-free.app";

      const { stdout } = await runAssistantCommandFull(
        "webhooks",
        "register",
        "telegram",
        "--path",
        "webhooks/telegram-v2",
        "--json",
      );

      const result = parseJson(stdout);
      expect(result.ok).toBe(true);
      expect(result.callbackUrl).toBe(
        "https://tunnel.ngrok-free.app/webhooks/telegram-v2",
      );
      expect(result.type).toBe("telegram");
      expect(result.path).toBe("webhooks/telegram-v2");
    });

    test("works with --path on platform mode", async () => {
      mockShouldUsePlatformCallbacks = true;
      mockRegisterCallbackRoute = async (path, type) => {
        expect(path).toBe("webhooks/my-custom");
        expect(type).toBe("custom_provider");
        return "https://callbacks.vellum.app/a/asst_123/webhooks/my-custom";
      };

      const { stdout } = await runAssistantCommandFull(
        "webhooks",
        "register",
        "custom_provider",
        "--path",
        "webhooks/my-custom",
        "--json",
      );

      const result = parseJson(stdout);
      expect(result.ok).toBe(true);
      expect(result.callbackUrl).toBe(
        "https://callbacks.vellum.app/a/asst_123/webhooks/my-custom",
      );
      expect(result.mode).toBe("platform");
    });
  });
});
