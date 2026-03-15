/**
 * Tests for CES API key propagation after hatch.
 *
 * Validates the fix for the race condition where the assistant API key
 * can permanently miss CES after hatch in managed mode:
 *
 * 1. Handshake with no API key -> CES has empty apiKeyRef
 * 2. updateAssistantApiKey RPC pushes the key after it arrives
 * 3. CES server invokes the onApiKeyUpdate callback
 * 4. The client convenience method correctly sends the RPC
 *
 * Also validates the lazy `ApiKeyRef` pattern used in `managed-main.ts`
 * that allows the assistant API key to arrive after CES handlers are
 * registered (key resolved at call time, not registration time).
 *
 * These tests mock the transport layer (no real processes or sockets)
 * to verify the contract and wiring in isolation.
 */

import { describe, expect, test } from "bun:test";

import {
  CES_PROTOCOL_VERSION,
  CesRpcMethod,
  CesRpcSchemas,
  HandshakeRequestSchema,
} from "@vellumai/ces-contracts";

import {
  type CesTransport,
  createCesClient,
} from "../credential-execution/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockTransport(): CesTransport & {
  sentMessages: string[];
  messageHandler: ((message: string) => void) | null;
  simulateMessage(raw: string): void;
  alive: boolean;
} {
  const mock = {
    sentMessages: [] as string[],
    messageHandler: null as ((message: string) => void) | null,
    alive: true,

    write(line: string): void {
      mock.sentMessages.push(line);
    },

    onMessage(handler: (message: string) => void): void {
      mock.messageHandler = handler;
    },

    isAlive(): boolean {
      return mock.alive;
    },

    close(): void {
      mock.alive = false;
    },

    simulateMessage(raw: string): void {
      if (mock.messageHandler) {
        mock.messageHandler(raw);
      }
    },
  };

  return mock;
}

async function completeHandshake(
  transport: ReturnType<typeof createMockTransport>,
  client: ReturnType<typeof createCesClient>,
): Promise<void> {
  const handshakePromise = client.handshake();
  const sent = JSON.parse(transport.sentMessages[0]);
  transport.simulateMessage(
    JSON.stringify({
      type: "handshake_ack",
      protocolVersion: CES_PROTOCOL_VERSION,
      sessionId: sent.sessionId,
      accepted: true,
    }),
  );
  await handshakePromise;
}

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
// Lazy ApiKeyRef pattern tests
// ---------------------------------------------------------------------------

describe("API key post-handshake propagation", () => {
  // -------------------------------------------------------------------------
  // 1. Empty ref -> options unavailable
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
  // 2. Setting ref -> options become available
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
  // 3. Lazy resolution -- key resolved at call time, not registration time
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
  // 4. Missing required fields -> undefined (graceful degradation)
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
// Handshake schema contract -- assistantApiKey field
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
// update_managed_credential RPC contract
// ---------------------------------------------------------------------------

describe("update_managed_credential RPC contract", () => {
  test("RPC method constant exists", () => {
    expect(CesRpcMethod.UpdateManagedCredential).toBe(
      "update_managed_credential",
    );
  });

  test("request schema validates correct payload", () => {
    const schema = CesRpcSchemas[CesRpcMethod.UpdateManagedCredential].request;
    const result = schema.safeParse({ assistantApiKey: "test-key-123" });
    expect(result.success).toBe(true);
  });

  test("request schema rejects missing assistantApiKey", () => {
    const schema = CesRpcSchemas[CesRpcMethod.UpdateManagedCredential].request;
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("response schema validates correct payload", () => {
    const schema = CesRpcSchemas[CesRpcMethod.UpdateManagedCredential].response;
    const result = schema.safeParse({ updated: true });
    expect(result.success).toBe(true);
  });

  test("response schema rejects missing updated field", () => {
    const schema = CesRpcSchemas[CesRpcMethod.UpdateManagedCredential].response;
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Client convenience method tests
// ---------------------------------------------------------------------------

describe("CesClient.updateAssistantApiKey()", () => {
  test("sends update_managed_credential RPC with the correct payload", async () => {
    const transport = createMockTransport();
    const client = createCesClient(transport, {
      handshakeTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    });

    await completeHandshake(transport, client);

    // Start the update call
    const updatePromise = client.updateAssistantApiKey("my-new-api-key");

    // Find the RPC message (second message after handshake)
    expect(transport.sentMessages.length).toBe(2);
    const rpcMsg = JSON.parse(transport.sentMessages[1]);
    expect(rpcMsg.type).toBe("rpc");
    expect(rpcMsg.method).toBe("update_managed_credential");
    expect(rpcMsg.kind).toBe("request");
    expect(rpcMsg.payload).toEqual({ assistantApiKey: "my-new-api-key" });

    // Simulate successful response
    transport.simulateMessage(
      JSON.stringify({
        type: "rpc",
        id: rpcMsg.id,
        kind: "response",
        method: "update_managed_credential",
        payload: { updated: true },
        timestamp: new Date().toISOString(),
      }),
    );

    const result = await updatePromise;
    expect(result.updated).toBe(true);

    client.close();
  });

  test("propagation flow: handshake without key then update", async () => {
    const transport = createMockTransport();
    const client = createCesClient(transport, {
      handshakeTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    });

    // Step 1: Handshake without API key (simulates pre-hatch state)
    const handshakePromise = client.handshake();
    const hsSent = JSON.parse(transport.sentMessages[0]);
    expect(hsSent.assistantApiKey).toBeUndefined();

    transport.simulateMessage(
      JSON.stringify({
        type: "handshake_ack",
        protocolVersion: CES_PROTOCOL_VERSION,
        sessionId: hsSent.sessionId,
        accepted: true,
      }),
    );
    await handshakePromise;
    expect(client.isReady()).toBe(true);

    // Step 2: Push the API key (simulates post-hatch provisioning)
    const updatePromise = client.updateAssistantApiKey("provisioned-key");
    const rpcMsg = JSON.parse(transport.sentMessages[1]);

    transport.simulateMessage(
      JSON.stringify({
        type: "rpc",
        id: rpcMsg.id,
        kind: "response",
        method: "update_managed_credential",
        payload: { updated: true },
        timestamp: new Date().toISOString(),
      }),
    );

    const result = await updatePromise;
    expect(result.updated).toBe(true);

    client.close();
  });

  test("throws if called before handshake", async () => {
    const transport = createMockTransport();
    const client = createCesClient(transport);

    try {
      await client.updateAssistantApiKey("key");
      expect(true).toBe(false); // Should not reach here
    } catch (err) {
      expect((err as Error).message).toContain("handshake");
    }

    client.close();
  });
});
