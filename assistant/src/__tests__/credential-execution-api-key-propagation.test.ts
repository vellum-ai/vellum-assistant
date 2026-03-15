/**
 * API key post-handshake propagation tests for managed CES.
 *
 * Validates the lazy `ApiKeyRef` pattern used in `managed-main.ts` that
 * allows the assistant API key to arrive after the CES process has started
 * and handlers have been registered. This is the critical managed-mode
 * scenario where the key is provisioned after hatch (the assistant hatches,
 * connects to CES via the bootstrap socket, and forwards the API key in
 * the handshake — but the handlers must already exist by that point).
 *
 * Tests cover:
 *
 * 1. When `apiKeyRef.current` is empty, managed options are unavailable.
 * 2. Setting `apiKeyRef.current` enables managed options with the key.
 * 3. Lazy resolution: handlers built with the ref resolve the key at
 *    call time, not at registration time.
 * 4. Handshake schema includes the optional `assistantApiKey` field.
 * 5. RPC contract for `UpdateAssistantApiKey` (todo — depends on
 *    parallel PR adding the RPC method).
 */

import { describe, expect, test } from "bun:test";

import { HandshakeRequestSchema } from "@vellumai/ces-contracts";

// ---------------------------------------------------------------------------
// Reproduce the ApiKeyRef + lazy getter pattern from managed-main.ts:89-146
// ---------------------------------------------------------------------------

// Inlined from credential-executor to avoid cross-package source imports
// (which pull in transitive deps that the assistant tsconfig can't resolve).
interface ManagedSubjectResolverOptions {
  platformBaseUrl: string;
  assistantApiKey: string;
  assistantId: string;
}

interface ManagedMaterializerOptions {
  platformBaseUrl: string;
  assistantApiKey: string;
  assistantId: string;
}

interface ApiKeyRef {
  current: string;
}

/**
 * Build the lazy getter functions that mirror managed-main.ts.
 * These test-local copies isolate the behavioral pattern from the full
 * managed-main.ts module (which requires process-level dependencies).
 */
function buildLazyGetters(opts: {
  platformBaseUrl: string;
  assistantId: string;
  apiKeyRef: ApiKeyRef;
  envApiKey?: string;
}) {
  const { platformBaseUrl, assistantId, apiKeyRef, envApiKey } = opts;

  const getAssistantApiKey = (): string => apiKeyRef.current || envApiKey || "";

  const getManagedSubjectOptions = ():
    | ManagedSubjectResolverOptions
    | undefined => {
    const key = getAssistantApiKey();
    return platformBaseUrl && key && assistantId
      ? { platformBaseUrl, assistantApiKey: key, assistantId }
      : undefined;
  };

  const getManagedMaterializerOptions = ():
    | ManagedMaterializerOptions
    | undefined => {
    const key = getAssistantApiKey();
    return platformBaseUrl && key && assistantId
      ? { platformBaseUrl, assistantApiKey: key, assistantId }
      : undefined;
  };

  return {
    getAssistantApiKey,
    getManagedSubjectOptions,
    getManagedMaterializerOptions,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("API key post-handshake propagation", () => {
  // -------------------------------------------------------------------------
  // 1. Empty ref → options unavailable
  // -------------------------------------------------------------------------

  describe("before API key arrives", () => {
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

  // -------------------------------------------------------------------------
  // 2. Setting ref → options become available
  // -------------------------------------------------------------------------

  describe("after API key arrives via handshake", () => {
    test("setting apiKeyRef.current enables managed subject options", () => {
      const apiKeyRef: ApiKeyRef = { current: "" };
      const { getManagedSubjectOptions } = buildLazyGetters({
        platformBaseUrl: "https://api.vellum.ai",
        assistantId: "ast_abc123",
        apiKeyRef,
      });

      // Before key arrives
      expect(getManagedSubjectOptions()).toBeUndefined();

      // Simulate handshake callback setting the key
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

      // Before key arrives
      expect(getManagedMaterializerOptions()).toBeUndefined();

      // Simulate handshake callback setting the key
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

      // Set first key
      apiKeyRef.current = "vak_key_v1";
      expect(getManagedSubjectOptions()!.assistantApiKey).toBe("vak_key_v1");
      expect(getManagedMaterializerOptions()!.assistantApiKey).toBe(
        "vak_key_v1",
      );

      // Rotate to a new key
      apiKeyRef.current = "vak_key_v2";
      expect(getManagedSubjectOptions()!.assistantApiKey).toBe("vak_key_v2");
      expect(getManagedMaterializerOptions()!.assistantApiKey).toBe(
        "vak_key_v2",
      );
    });
  });

  // -------------------------------------------------------------------------
  // 3. Lazy resolution — key resolved at call time, not registration time
  // -------------------------------------------------------------------------

  describe("lazy resolution timing", () => {
    test("handlers built before key arrives resolve the key at call time", () => {
      const apiKeyRef: ApiKeyRef = { current: "" };

      // Build getters (simulating handler registration at startup)
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

      // Build a deps object with getters, mirroring managed-main.ts:186-196
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
      const { getAssistantApiKey, getManagedSubjectOptions } = buildLazyGetters(
        {
          platformBaseUrl: "https://api.vellum.ai",
          assistantId: "ast_abc123",
          apiKeyRef,
          envApiKey: "vak_env_fallback",
        },
      );

      // Ref is empty but env var provides the key
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

      // Before handshake: falls back to env
      expect(getAssistantApiKey()).toBe("vak_env_key");

      // After handshake: ref takes precedence
      apiKeyRef.current = "vak_handshake_key";
      expect(getAssistantApiKey()).toBe("vak_handshake_key");
    });
  });

  // -------------------------------------------------------------------------
  // 4. Missing required fields → undefined (graceful degradation)
  // -------------------------------------------------------------------------

  describe("missing platform config fields", () => {
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
});

// ---------------------------------------------------------------------------
// Handshake schema contract — assistantApiKey field
// ---------------------------------------------------------------------------

describe("handshake schema includes assistantApiKey", () => {
  test("HandshakeRequestSchema has an optional assistantApiKey field", () => {
    // The assistantApiKey field in the handshake request is what carries
    // the API key from the assistant to CES during bootstrap.
    const shape = HandshakeRequestSchema.shape;
    expect(shape.assistantApiKey).toBeDefined();
  });

  test("handshake request validates with assistantApiKey present", () => {
    const result = HandshakeRequestSchema.safeParse({
      type: "handshake_request",
      protocolVersion: "0.1.0",
      sessionId: "test-session",
      assistantApiKey: "vak_test_key_12345",
    });
    expect(result.success).toBe(true);
  });

  test("handshake request validates without assistantApiKey (optional)", () => {
    const result = HandshakeRequestSchema.safeParse({
      type: "handshake_request",
      protocolVersion: "0.1.0",
      sessionId: "test-session",
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UpdateAssistantApiKey RPC contract (depends on parallel PR)
// ---------------------------------------------------------------------------

describe("UpdateAssistantApiKey RPC contract", () => {
  test.todo("UpdateAssistantApiKey method exists in CesRpcMethod", () => {
    // Depends on parallel PR adding CesRpcMethod.UpdateAssistantApiKey
    // to the ces-contracts package. Once that lands, this test should
    // verify:
    //   expect(CesRpcMethod.UpdateAssistantApiKey).toBe("update_assistant_api_key");
    //   expect(CesRpcSchemas[CesRpcMethod.UpdateAssistantApiKey]).toBeDefined();
    //   expect(CesRpcSchemas[CesRpcMethod.UpdateAssistantApiKey].request).toBeDefined();
    //   expect(CesRpcSchemas[CesRpcMethod.UpdateAssistantApiKey].response).toBeDefined();
  });
});
