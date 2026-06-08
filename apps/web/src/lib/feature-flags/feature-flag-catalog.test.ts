import { describe, expect, test } from "bun:test";

import {
  ASSISTANT_FLAG_DEFAULTS,
  CLIENT_FLAG_DEFAULTS,
  getEnvFlagOverridesForScope,
  readEnvFlagOverrides,
  scopeIncludes,
} from "@/lib/feature-flags/feature-flag-catalog";

describe("feature flag catalog", () => {
  test("exposes self-intro greeting to client and assistant flag stores", () => {
    expect(CLIENT_FLAG_DEFAULTS.selfIntroGreeting).toBe(false);
    expect(ASSISTANT_FLAG_DEFAULTS.selfIntroGreeting).toBe(false);
  });

  test("exposes the activation flow experiment as a client flag", () => {
    expect(CLIENT_FLAG_DEFAULTS.experimentActivationFlow20260603).toBe(false);
    expect("experimentActivationFlow20260603" in ASSISTANT_FLAG_DEFAULTS).toBe(
      false
    );
  });

  test("exposes dynamic empty-state greetings as an assistant flag", () => {
    expect(ASSISTANT_FLAG_DEFAULTS.emptyStateDynamicGreetings).toBe(false);
    expect("emptyStateDynamicGreetings" in CLIENT_FLAG_DEFAULTS).toBe(false);
  });
});

describe("readEnvFlagOverrides", () => {
  test("returns empty object when neither window global nor Vite env vars are present", () => {
    const overrides = readEnvFlagOverrides();
    expect(overrides).toEqual({});
  });

  test("reads from window.__VELLUM_FLAG_OVERRIDES__ when set before module load", async () => {
    // Set up the global before importing a fresh module instance
    (globalThis as Record<string, unknown>).window = {
      __VELLUM_FLAG_OVERRIDES__: {
        "self-intro-greeting": true,
        "home-tab": "variant-a",
      },
    };

    try {
      // Bust the module cache by appending a query parameter
      const mod = await import(
        "@/lib/feature-flags/feature-flag-catalog?t=window-test"
      );
      const overrides = mod.readEnvFlagOverrides();
      expect(overrides).toEqual({
        "self-intro-greeting": true,
        "home-tab": "variant-a",
      });
    } finally {
      delete (globalThis as Record<string, unknown>).window;
    }
  });
});

describe("getEnvFlagOverridesForScope", () => {
  test("returns empty bool and str maps when no overrides are present", () => {
    const result = getEnvFlagOverridesForScope("client");
    expect(result).toEqual({ bool: {}, str: {} });
  });

  test("filters client-scoped flags and separates bool/str", async () => {
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

    try {
      const mod = await import(
        "@/lib/feature-flags/feature-flag-catalog?t=scope-client"
      );
      const result = mod.getEnvFlagOverridesForScope("client");
      expect(result.bool).toEqual({ homeTab: true });
      expect(result.str).toEqual({
        preChatOnboardingExperiment20260606: "variant-a",
      });
      // assistant-only flag should not appear
      expect(result.bool).not.toHaveProperty("autoAnalyze");
    } finally {
      delete (globalThis as Record<string, unknown>).window;
    }
  });

  test("flags with scope 'both' appear for both client and assistant scopes", async () => {
    (globalThis as Record<string, unknown>).window = {
      __VELLUM_FLAG_OVERRIDES__: {
        "self-intro-greeting": true,
      },
    };

    try {
      const mod = await import(
        "@/lib/feature-flags/feature-flag-catalog?t=scope-both"
      );
      const clientResult = mod.getEnvFlagOverridesForScope("client");
      const assistantResult = mod.getEnvFlagOverridesForScope("assistant");

      expect(clientResult.bool).toEqual({ selfIntroGreeting: true });
      expect(assistantResult.bool).toEqual({ selfIntroGreeting: true });
    } finally {
      delete (globalThis as Record<string, unknown>).window;
    }
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
