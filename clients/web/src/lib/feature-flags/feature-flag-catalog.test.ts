import { afterEach, describe, expect, test } from "bun:test";

import {
  ASSISTANT_FLAG_DEFAULTS,
  CLIENT_FLAG_DEFAULTS,
  CLIENT_STRING_FLAG_DEFAULTS,
  getEnvFlagOverridesForScope,
  readEnvFlagOverrides,
  resetEnvOverridesCache,
  scopeIncludes,
} from "@/lib/feature-flags/feature-flag-catalog";

const originalWindow = (globalThis as Record<string, unknown>).window;

afterEach(() => {
  resetEnvOverridesCache();
  (globalThis as Record<string, unknown>).window = originalWindow;
});

describe("feature flag catalog", () => {
  test("exposes self-intro greeting to client and assistant flag stores", () => {
    expect(CLIENT_FLAG_DEFAULTS.selfIntroGreeting).toBe(false);
    expect(ASSISTANT_FLAG_DEFAULTS.selfIntroGreeting).toBe(false);
  });

  test("exposes the activation flow experiment as a client string flag", () => {
    expect(CLIENT_STRING_FLAG_DEFAULTS.experimentActivationFlow20260603).toBe(
      "control",
    );
    expect("experimentActivationFlow20260603" in CLIENT_FLAG_DEFAULTS).toBe(
      false,
    );
    expect("experimentActivationFlow20260603" in ASSISTANT_FLAG_DEFAULTS).toBe(
      false,
    );
  });

  test("does not expose GA empty-state greetings as a feature flag", () => {
    expect("emptyStateDynamicGreetings" in ASSISTANT_FLAG_DEFAULTS).toBe(false);
    expect("emptyStateDynamicGreetings" in CLIENT_FLAG_DEFAULTS).toBe(false);
  });

  test("does not expose GA quote reply as a feature flag", () => {
    expect("quoteReply" in CLIENT_FLAG_DEFAULTS).toBe(false);
    expect("quoteReply" in ASSISTANT_FLAG_DEFAULTS).toBe(false);
  });

  test("exposes web remote ingress as an assistant flag defaulted off", () => {
    expect(ASSISTANT_FLAG_DEFAULTS.webRemoteIngress).toBe(false);
    expect("webRemoteIngress" in CLIENT_FLAG_DEFAULTS).toBe(false);
  });

  test("exposes the MCP add-server gate without a page-level MCP gate", () => {
    expect("mcpSettings" in ASSISTANT_FLAG_DEFAULTS).toBe(false);
    expect(ASSISTANT_FLAG_DEFAULTS.mcpAddServer).toBe(false);
  });
});

describe("readEnvFlagOverrides", () => {
  test("returns empty object when neither window global nor Vite env vars are present", () => {
    const overrides = readEnvFlagOverrides();
    expect(overrides).toEqual({});
  });

  test("reads from window.__VELLUM_FLAG_OVERRIDES__ when set", () => {
    (globalThis as Record<string, unknown>).window = {
      __VELLUM_FLAG_OVERRIDES__: {
        "self-intro-greeting": true,
        "home-tab": "variant-a",
      },
    };
    resetEnvOverridesCache();

    const overrides = readEnvFlagOverrides();
    expect(overrides).toEqual({
      "self-intro-greeting": true,
      "home-tab": "variant-a",
    });
  });
});

describe("getEnvFlagOverridesForScope", () => {
  test("returns empty bool and str maps when no overrides are present", () => {
    const result = getEnvFlagOverridesForScope("client");
    expect(result).toEqual({ bool: {}, str: {} });
  });

  test("filters client-scoped flags and separates bool/str", () => {
    (globalThis as Record<string, unknown>).window = {
      __VELLUM_FLAG_OVERRIDES__: {
        // client-only flag (boolean)
        "home-tab": true,
        // assistant-only flag (boolean) — should be excluded from client scope
        "auto-analyze": true,
        // client-only flag (string)
        "pre-chat-onboarding-experiment-2026-06-06": "variant-a",
      },
    };
    resetEnvOverridesCache();

    const result = getEnvFlagOverridesForScope("client");
    expect(result.bool).toEqual({ homeTab: true });
    expect(result.str).toEqual({
      preChatOnboardingExperiment20260606: "variant-a",
    });
    expect(result.bool).not.toHaveProperty("autoAnalyze");
  });

  test("flags with scope 'both' appear for both client and assistant scopes", () => {
    (globalThis as Record<string, unknown>).window = {
      __VELLUM_FLAG_OVERRIDES__: {
        "self-intro-greeting": true,
      },
    };
    resetEnvOverridesCache();

    const clientResult = getEnvFlagOverridesForScope("client");
    const assistantResult = getEnvFlagOverridesForScope("assistant");

    expect(clientResult.bool).toEqual({ selfIntroGreeting: true });
    expect(assistantResult.bool).toEqual({ selfIntroGreeting: true });
  });
});

describe("scopeIncludes", () => {
  test("'both' includes client and assistant", () => {
    expect(scopeIncludes("both", "client")).toBe(true);
    expect(scopeIncludes("both", "assistant")).toBe(true);
  });

  test("'client' only includes client", () => {
    expect(scopeIncludes("client", "client")).toBe(true);
    expect(scopeIncludes("client", "assistant")).toBe(false);
  });

  test("'assistant' only includes assistant", () => {
    expect(scopeIncludes("assistant", "assistant")).toBe(true);
    expect(scopeIncludes("assistant", "client")).toBe(false);
  });
});
