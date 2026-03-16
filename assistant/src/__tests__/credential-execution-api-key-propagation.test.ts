/**
 * Tests for CES API key propagation after hatch — **client side**.
 *
 * Validates the fix for the race condition where the assistant API key
 * can permanently miss CES after hatch in managed mode:
 *
 * 1. Handshake with no API key -> CES has empty apiKeyRef
 * 2. updateAssistantApiKey RPC pushes the key after it arrives
 * 3. CES server invokes the onApiKeyUpdate callback
 * 4. The client convenience method correctly sends the RPC
 *
 * ## What this file tests (and what it does NOT)
 *
 * This file exercises **production code** exclusively:
 * - `createCesClient` from `credential-execution/client.ts`
 * - Zod schemas from `@vellumai/ces-contracts` (HandshakeRequestSchema,
 *   CesRpcSchemas, CesRpcMethod)
 *
 * The `createMockTransport` helper is a mock of the **transport layer**
 * (stdin/stdout or Unix socket), not a reimplementation of any production
 * logic. The transport interface is intentionally thin (write/onMessage/
 * isAlive/close) so the mock is trivial and cannot diverge from real
 * behaviour.
 *
 * The **server-side** lazy `ApiKeyRef` pattern used in `managed-main.ts`
 * is tested directly in
 * `credential-executor/src/__tests__/managed-lazy-getters.test.ts`
 * against the production `buildLazyGetters` function. A structural guard
 * below verifies that `managed-main.ts` imports `buildLazyGetters` from
 * `managed-lazy-getters.ts`, so these two test files stay coupled to
 * production code.
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
      conversationId: sent.conversationId,
      accepted: true,
    }),
  );
  await handshakePromise;
}

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
      conversationId: "test-session",
      assistantApiKey: "vak_test_key_12345",
    });
    expect(result.success).toBe(true);
  });

  test("handshake request validates without assistantApiKey (optional)", () => {
    const result = HandshakeRequestSchema.safeParse({
      type: "handshake_request",
      protocolVersion: "0.1.0",
      conversationId: "test-session",
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
        conversationId: hsSent.conversationId,
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

// ---------------------------------------------------------------------------
// Structural guard: managed-main.ts uses production buildLazyGetters
// ---------------------------------------------------------------------------

describe("structural guard: managed-main.ts uses production buildLazyGetters", () => {
  test("managed-main.ts imports buildLazyGetters from managed-lazy-getters", async () => {
    // This guard ensures that managed-main.ts exercises the production
    // buildLazyGetters function (tested in managed-lazy-getters.test.ts),
    // not a local reimplementation. If the import is removed or the source
    // module changes, this test will fail and signal that the companion
    // test coverage may no longer be wired to production code.
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");

    // Resolve from the repo root (three levels up from __tests__/)
    const repoRoot = join(dirname(import.meta.dir), "..", "..");
    const managedMainPath = join(
      repoRoot,
      "credential-executor",
      "src",
      "managed-main.ts",
    );

    const source = readFileSync(managedMainPath, "utf-8");

    expect(source).toContain('from "./managed-lazy-getters.js"');
    expect(source).toMatch(
      /import\s+\{[^}]*buildLazyGetters[^}]*\}\s+from\s+["']\.\/managed-lazy-getters\.js["']/,
    );
  });
});
