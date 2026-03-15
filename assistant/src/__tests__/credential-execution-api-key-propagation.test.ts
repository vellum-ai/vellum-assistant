/**
 * Tests for CES API key propagation after hatch.
 *
 * Validates the fix for the race condition where the assistant API key
 * can permanently miss CES after hatch in managed mode:
 *
 * 1. Handshake with no API key → CES has empty apiKeyRef
 * 2. updateAssistantApiKey RPC pushes the key after it arrives
 * 3. CES server invokes the onApiKeyUpdate callback
 * 4. The client convenience method correctly sends the RPC
 *
 * These tests mock the transport layer (no real processes or sockets)
 * to verify the contract and wiring in isolation.
 */

import { describe, expect, test } from "bun:test";

import {
  CES_PROTOCOL_VERSION,
  CesRpcMethod,
  CesRpcSchemas,
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
// Contract tests
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
  test("sends update_assistant_api_key RPC with the correct payload", async () => {
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
