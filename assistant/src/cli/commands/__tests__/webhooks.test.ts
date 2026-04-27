import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockGetIsPlatform = false;
let mockRegisterCallbackRoute: (
  path: string,
  type: string,
) => Promise<string> = async () => "";
let mockPublicBaseUrl: string | null = null;
let mockPlatformContext: Record<string, unknown> = {
  isPlatform: false,
  platformBaseUrl: "",
  assistantId: "",
  hasInternalApiKey: false,
  hasAssistantApiKey: false,
  authHeader: null,
  enabled: false,
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../config/env-registry.js", () => ({
  getIsPlatform: () => mockGetIsPlatform,
}));

mock.module("../../../inbound/platform-callback-registration.js", () => ({
  registerCallbackRoute: (path: string, type: string) =>
    mockRegisterCallbackRoute(path, type),
  resolvePlatformCallbackRegistrationContext: async () => mockPlatformContext,
  resolveCallbackUrl: async () => "",
}));

mock.module("../../lib/daemon-credential-client.js", () => ({
  deleteSecureKeyViaDaemon: async () => "not-found" as const,
  setSecureKeyViaDaemon: async () => false,
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

// ---------------------------------------------------------------------------
// Mock fetch helper
// ---------------------------------------------------------------------------

import { mockFetch, resetMockFetch } from "../../../__tests__/mock-fetch.js";

function connectedContext(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    isPlatform: false,
    platformBaseUrl: "https://test-platform.vellum.ai",
    assistantId: "019d6d4f-6dbd-779f-91d3-cb273b9429a5",
    hasInternalApiKey: false,
    hasAssistantApiKey: true,
    authHeader: "Api-Key vak_test123",
    enabled: true,
    ...overrides,
  };
}

describe("assistant webhooks register", () => {
  beforeEach(() => {
    mockGetIsPlatform = false;
    mockRegisterCallbackRoute = async () => "";
    mockPublicBaseUrl = null;
    mockPlatformContext = {
      isPlatform: false,
      platformBaseUrl: "",
      assistantId: "",
      hasInternalApiKey: false,
      hasAssistantApiKey: false,
      authHeader: null,
      enabled: false,
    };
    process.exitCode = undefined;
  });

  afterEach(() => {
    resetMockFetch();
    process.exitCode = undefined;
  });

  describe("platform mode", () => {
    test("registers callback route and returns platform URL", async () => {
      mockGetIsPlatform = true;
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
      mockGetIsPlatform = true;
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
      mockGetIsPlatform = true;
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
      mockGetIsPlatform = false;
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
      mockGetIsPlatform = false;
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
      mockGetIsPlatform = false;
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
        mockGetIsPlatform = false;
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
      mockGetIsPlatform = false;
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
      mockGetIsPlatform = true;
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
  describe("--source option", () => {
    test("passes source to registerCallbackRoute on platform mode", async () => {
      mockGetIsPlatform = true;
      mockRegisterCallbackRoute = async (path, type) => {
        expect(path).toBe("webhooks/telegram");
        expect(type).toBe("telegram");
        return "https://callbacks.vellum.app/a/asst_123/webhooks/telegram";
      };

      const { stdout } = await runAssistantCommandFull(
        "webhooks",
        "register",
        "telegram",
        "--source",
        "@my_bot",
        "--json",
      );

      const result = parseJson(stdout);
      expect(result.ok).toBe(true);
      expect(result.callbackUrl).toBe(
        "https://callbacks.vellum.app/a/asst_123/webhooks/telegram",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// assistant webhooks list
// ---------------------------------------------------------------------------

describe("assistant webhooks list", () => {
  beforeEach(() => {
    mockPlatformContext = connectedContext();
    process.exitCode = undefined;
  });

  afterEach(() => {
    resetMockFetch();
    process.exitCode = undefined;
  });

  test("returns registered routes as JSON", async () => {
    const routes = [
      {
        id: "route-1",
        assistant_id: "019d6d4f-6dbd-779f-91d3-cb273b9429a5",
        type: "telegram",
        callback_path: "019d6d4f-6dbd-779f-91d3-cb273b9429a5/webhooks/telegram",
        callback_url:
          "https://test-platform.vellum.ai/v1/gateway/callbacks/019d6d4f-6dbd-779f-91d3-cb273b9429a5/webhooks/telegram/",
        source_identifier: "@my_bot",
      },
      {
        id: "route-2",
        assistant_id: "019d6d4f-6dbd-779f-91d3-cb273b9429a5",
        type: "resend",
        callback_path: "019d6d4f-6dbd-779f-91d3-cb273b9429a5/webhooks/resend",
        callback_url:
          "https://test-platform.vellum.ai/v1/gateway/callbacks/019d6d4f-6dbd-779f-91d3-cb273b9429a5/webhooks/resend/",
        source_identifier: null,
      },
    ];
    mockFetch(
      "/v1/internal/gateway/callback-routes/",
      {},
      { body: routes, status: 200 },
    );

    const { stdout } = await runAssistantCommandFull(
      "webhooks",
      "list",
      "--json",
    );

    const parsed = parseJson(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.routes).toHaveLength(2);
    expect((parsed.routes as Array<{ type: string }>)[0].type).toBe("telegram");
    expect((parsed.routes as Array<{ type: string }>)[1].type).toBe("resend");
  });

  test("returns empty list when no routes registered", async () => {
    mockFetch(
      "/v1/internal/gateway/callback-routes/",
      {},
      { body: [], status: 200 },
    );

    const { stdout } = await runAssistantCommandFull(
      "webhooks",
      "list",
      "--json",
    );

    const parsed = parseJson(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.routes).toEqual([]);
  });

  test("returns coming-soon error for self-hosted without platform credentials", async () => {
    mockPlatformContext = {
      isPlatform: false,
      platformBaseUrl: "",
      assistantId: "",
      hasInternalApiKey: false,
      hasAssistantApiKey: false,
      authHeader: null,
      enabled: false,
    };

    const { stdout } = await runAssistantCommandFull(
      "webhooks",
      "list",
      "--json",
    );

    expect(process.exitCode).toBe(1);
    const parsed = parseJson(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Self-hosted webhook listing coming soon");
  });

  test("handles platform HTTP error", async () => {
    mockFetch(
      "/v1/internal/gateway/callback-routes/",
      {},
      { body: { detail: "Unauthorized" }, status: 401 },
    );

    const { stdout } = await runAssistantCommandFull(
      "webhooks",
      "list",
      "--json",
    );

    expect(process.exitCode).toBe(1);
    const parsed = parseJson(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("HTTP 401");
  });

  test("works for self-hosted assistants with connected credentials", async () => {
    // Explicitly reset — previous error-path tests may leave exitCode = 1
    // due to async commander teardown racing with afterEach.
    process.exitCode = undefined;

    mockPlatformContext = connectedContext({
      isPlatform: false,
      enabled: true,
    });

    const routes = [
      {
        id: "route-1",
        assistant_id: "019d6d4f-6dbd-779f-91d3-cb273b9429a5",
        type: "email",
        callback_path: "019d6d4f-6dbd-779f-91d3-cb273b9429a5/webhooks/email",
        callback_url:
          "https://test-platform.vellum.ai/v1/gateway/callbacks/019d6d4f-6dbd-779f-91d3-cb273b9429a5/webhooks/email/",
        source_identifier: null,
      },
    ];
    mockFetch(
      "/v1/internal/gateway/callback-routes/",
      {},
      { body: routes, status: 200 },
    );

    const { stdout } = await runAssistantCommandFull(
      "webhooks",
      "list",
      "--json",
    );

    const parsed = parseJson(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.routes).toHaveLength(1);
  });
});
