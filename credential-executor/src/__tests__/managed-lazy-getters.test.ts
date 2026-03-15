/**
 * Tests for the managed CES lazy API key getter pattern.
 *
 * Exercises the production `buildLazyGetters` from `managed-lazy-getters.ts`
 * directly, ensuring regressions in key precedence, lazy resolution, or
 * graceful degradation are caught by these tests.
 */

import { describe, expect, test } from "bun:test";

import {
  buildLazyGetters,
  type ApiKeyRef,
} from "../managed-lazy-getters.js";

// ---------------------------------------------------------------------------
// Before API key arrives
// ---------------------------------------------------------------------------

describe("managed lazy getters — before API key arrives", () => {
  test("apiKeyRef starts empty and managed subject options are undefined", () => {
    const apiKeyRef: ApiKeyRef = { current: "" };
    const { getManagedSubjectOptions } = buildLazyGetters({
      platformBaseUrl: "https://api.vellum.ai",
      assistantId: "ast_abc123",
      apiKeyRef,
    });

    expect(apiKeyRef.current).toBe("");
    expect(getManagedSubjectOptions()).toBeUndefined();
  });

  test("apiKeyRef starts empty and managed materializer options are undefined", () => {
    const apiKeyRef: ApiKeyRef = { current: "" };
    const { getManagedMaterializerOptions } = buildLazyGetters({
      platformBaseUrl: "https://api.vellum.ai",
      assistantId: "ast_abc123",
      apiKeyRef,
    });

    expect(getManagedMaterializerOptions()).toBeUndefined();
  });

  test("getAssistantApiKey returns empty string when ref is empty and no env var", () => {
    const apiKeyRef: ApiKeyRef = { current: "" };
    const { getAssistantApiKey } = buildLazyGetters({
      platformBaseUrl: "https://api.vellum.ai",
      assistantId: "ast_abc123",
      apiKeyRef,
    });

    expect(getAssistantApiKey()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// After API key arrives via handshake
// ---------------------------------------------------------------------------

describe("managed lazy getters — after API key arrives via handshake", () => {
  test("setting apiKeyRef.current enables managed subject options", () => {
    const apiKeyRef: ApiKeyRef = { current: "" };
    const { getManagedSubjectOptions } = buildLazyGetters({
      platformBaseUrl: "https://api.vellum.ai",
      assistantId: "ast_abc123",
      apiKeyRef,
    });

    expect(getManagedSubjectOptions()).toBeUndefined();

    apiKeyRef.current = "vak_test_key_12345";

    const opts = getManagedSubjectOptions();
    expect(opts).toBeDefined();
    expect(opts!.platformBaseUrl).toBe("https://api.vellum.ai");
    expect(opts!.assistantApiKey).toBe("vak_test_key_12345");
    expect(opts!.assistantId).toBe("ast_abc123");
  });

  test("setting apiKeyRef.current enables managed materializer options", () => {
    const apiKeyRef: ApiKeyRef = { current: "" };
    const { getManagedMaterializerOptions } = buildLazyGetters({
      platformBaseUrl: "https://api.vellum.ai",
      assistantId: "ast_abc123",
      apiKeyRef,
    });

    expect(getManagedMaterializerOptions()).toBeUndefined();

    apiKeyRef.current = "vak_test_key_12345";

    const opts = getManagedMaterializerOptions();
    expect(opts).toBeDefined();
    expect(opts!.platformBaseUrl).toBe("https://api.vellum.ai");
    expect(opts!.assistantApiKey).toBe("vak_test_key_12345");
    expect(opts!.assistantId).toBe("ast_abc123");
  });

  test("returned options contain the exact key from the ref (not a stale copy)", () => {
    const apiKeyRef: ApiKeyRef = { current: "" };
    const { getManagedSubjectOptions, getManagedMaterializerOptions } =
      buildLazyGetters({
        platformBaseUrl: "https://api.vellum.ai",
        assistantId: "ast_abc123",
        apiKeyRef,
      });

    apiKeyRef.current = "vak_key_v1";
    expect(getManagedSubjectOptions()!.assistantApiKey).toBe("vak_key_v1");
    expect(getManagedMaterializerOptions()!.assistantApiKey).toBe("vak_key_v1");

    apiKeyRef.current = "vak_key_v2";
    expect(getManagedSubjectOptions()!.assistantApiKey).toBe("vak_key_v2");
    expect(getManagedMaterializerOptions()!.assistantApiKey).toBe("vak_key_v2");
  });
});

// ---------------------------------------------------------------------------
// Lazy resolution timing
// ---------------------------------------------------------------------------

describe("managed lazy getters — lazy resolution timing", () => {
  test("handlers built before key arrives resolve the key at call time", () => {
    const apiKeyRef: ApiKeyRef = { current: "" };

    const { getManagedSubjectOptions, getManagedMaterializerOptions } =
      buildLazyGetters({
        platformBaseUrl: "https://api.vellum.ai",
        assistantId: "ast_abc123",
        apiKeyRef,
      });

    // At registration time: no key yet
    expect(getManagedSubjectOptions()).toBeUndefined();
    expect(getManagedMaterializerOptions()).toBeUndefined();

    // Later: handshake delivers the key
    apiKeyRef.current = "vak_late_arriving_key";

    // Same getter functions now return valid options
    expect(getManagedSubjectOptions()).toBeDefined();
    expect(getManagedMaterializerOptions()).toBeDefined();
    expect(getManagedSubjectOptions()!.assistantApiKey).toBe(
      "vak_late_arriving_key",
    );
  });

  test("deps object with getter properties resolves lazily (mirrors httpDeps pattern)", () => {
    const apiKeyRef: ApiKeyRef = { current: "" };
    const { getManagedSubjectOptions, getManagedMaterializerOptions } =
      buildLazyGetters({
        platformBaseUrl: "https://api.vellum.ai",
        assistantId: "ast_abc123",
        apiKeyRef,
      });

    // Build a deps object with getters, mirroring managed-main.ts httpDeps
    const httpDeps = {
      get managedSubjectOptions() {
        return getManagedSubjectOptions();
      },
      get managedMaterializerOptions() {
        return getManagedMaterializerOptions();
      },
    };

    // Before key: both undefined
    expect(httpDeps.managedSubjectOptions).toBeUndefined();
    expect(httpDeps.managedMaterializerOptions).toBeUndefined();

    // After key: both resolved
    apiKeyRef.current = "vak_lazy_key";
    expect(httpDeps.managedSubjectOptions).toBeDefined();
    expect(httpDeps.managedSubjectOptions!.assistantApiKey).toBe(
      "vak_lazy_key",
    );
    expect(httpDeps.managedMaterializerOptions).toBeDefined();
    expect(httpDeps.managedMaterializerOptions!.assistantApiKey).toBe(
      "vak_lazy_key",
    );
  });

  test("env var fallback is used when ref is empty", () => {
    const apiKeyRef: ApiKeyRef = { current: "" };
    const { getAssistantApiKey, getManagedSubjectOptions } = buildLazyGetters({
      platformBaseUrl: "https://api.vellum.ai",
      assistantId: "ast_abc123",
      apiKeyRef,
      envApiKey: "vak_env_fallback",
    });

    expect(getAssistantApiKey()).toBe("vak_env_fallback");
    expect(getManagedSubjectOptions()).toBeDefined();
    expect(getManagedSubjectOptions()!.assistantApiKey).toBe(
      "vak_env_fallback",
    );
  });

  test("handshake-provided key takes precedence over env var", () => {
    const apiKeyRef: ApiKeyRef = { current: "" };
    const { getAssistantApiKey } = buildLazyGetters({
      platformBaseUrl: "https://api.vellum.ai",
      assistantId: "ast_abc123",
      apiKeyRef,
      envApiKey: "vak_env_key",
    });

    expect(getAssistantApiKey()).toBe("vak_env_key");

    apiKeyRef.current = "vak_handshake_key";
    expect(getAssistantApiKey()).toBe("vak_handshake_key");
  });
});

// ---------------------------------------------------------------------------
// Missing required fields -> undefined (graceful degradation)
// ---------------------------------------------------------------------------

describe("managed lazy getters — missing platform config fields", () => {
  test("missing platformBaseUrl returns undefined even with API key", () => {
    const apiKeyRef: ApiKeyRef = { current: "vak_test_key" };
    const { getManagedSubjectOptions, getManagedMaterializerOptions } =
      buildLazyGetters({
        platformBaseUrl: "",
        assistantId: "ast_abc123",
        apiKeyRef,
      });

    expect(getManagedSubjectOptions()).toBeUndefined();
    expect(getManagedMaterializerOptions()).toBeUndefined();
  });

  test("missing assistantId returns undefined even with API key", () => {
    const apiKeyRef: ApiKeyRef = { current: "vak_test_key" };
    const { getManagedSubjectOptions, getManagedMaterializerOptions } =
      buildLazyGetters({
        platformBaseUrl: "https://api.vellum.ai",
        assistantId: "",
        apiKeyRef,
      });

    expect(getManagedSubjectOptions()).toBeUndefined();
    expect(getManagedMaterializerOptions()).toBeUndefined();
  });
});
