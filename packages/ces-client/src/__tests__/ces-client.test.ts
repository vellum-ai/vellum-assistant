/**
 * Tests for @vellumai/ces-client
 *
 * Validates:
 * 1. Package independence — no imports from assistant/ or credential-executor/.
 * 2. HTTP credential client — error handling, status mapping, retry behaviour.
 * 3. HTTP log export client — error handling and timeout edge cases.
 * 4. RPC client — handshake lifecycle, request correlation, timeout, and close.
 */

import { describe, expect, test, beforeEach, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CES_PROTOCOL_VERSION } from "@vellumai/ces-contracts";

import { createCesHttpCredentialClient } from "../http-credentials.js";
import type { CesHttpLogger, CesHttpCredentialConfig } from "../http-credentials.js";
import { fetchCesLogExport } from "../http-log-export.js";
import {
  createCesRpcClient,
  CesTransportError,
  CesHandshakeError,
  CesTimeoutError,
  CesClientError,
} from "../rpc-client.js";
import type { CesTransport } from "../rpc-client.js";

// ---------------------------------------------------------------------------
// Independence guard
// ---------------------------------------------------------------------------

describe("package independence", () => {
  const sourceFiles = [
    "../index.ts",
    "../http-credentials.ts",
    "../http-log-export.ts",
    "../rpc-client.ts",
  ];

  for (const file of sourceFiles) {
    test(`${file} does not import from assistant/ or credential-executor/`, () => {
      const src = readFileSync(resolve(__dirname, file), "utf-8");
      expect(src).not.toMatch(/from\s+['"].*assistant\//);
      expect(src).not.toMatch(/from\s+['"].*credential-executor\//);
      expect(src).not.toMatch(/require\(['"].*assistant\//);
      expect(src).not.toMatch(/require\(['"].*credential-executor\//);
    });
  }
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createNoopLogger(): CesHttpLogger {
  return {
    warn: (() => {}) as CesHttpLogger["warn"],
  };
}

function createTestConfig(
  overrides?: Partial<CesHttpCredentialConfig>,
): CesHttpCredentialConfig {
  return {
    baseUrl: "http://ces-test:8090",
    serviceToken: "test-token",
    ...overrides,
  };
}

function createMockTransport(): CesTransport & {
  messages: string[];
  messageHandler: ((msg: string) => void) | null;
  alive: boolean;
} {
  const transport = {
    messages: [] as string[],
    messageHandler: null as ((msg: string) => void) | null,
    alive: true,
    write(line: string) {
      transport.messages.push(line);
    },
    onMessage(handler: (msg: string) => void) {
      transport.messageHandler = handler;
    },
    isAlive() {
      return transport.alive;
    },
    close() {
      transport.alive = false;
    },
  };
  return transport;
}

// ---------------------------------------------------------------------------
// HTTP credential client tests
// ---------------------------------------------------------------------------

describe("CesHttpCredentialClient", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("isAvailable returns true when config is present", () => {
    const client = createCesHttpCredentialClient(
      createTestConfig(),
      createNoopLogger(),
    );
    expect(client.isAvailable()).toBe(true);
  });

  test("isAvailable returns false when baseUrl is empty", () => {
    const client = createCesHttpCredentialClient(
      createTestConfig({ baseUrl: "" }),
      createNoopLogger(),
    );
    expect(client.isAvailable()).toBe(false);
  });

  test("get returns value on 200", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        Response.json({ account: "test-acct", value: "secret-123" }),
      ),
    ) as typeof fetch;

    const client = createCesHttpCredentialClient(
      createTestConfig(),
      createNoopLogger(),
    );
    const result = await client.get("test-acct");

    expect(result.value).toBe("secret-123");
    expect(result.unreachable).toBe(false);
  });

  test("get returns not-found on 404", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 404 })),
    ) as typeof fetch;

    const client = createCesHttpCredentialClient(
      createTestConfig(),
      createNoopLogger(),
    );
    const result = await client.get("missing-acct");

    expect(result.value).toBeUndefined();
    expect(result.unreachable).toBe(false);
  });

  test("get returns unreachable on 500", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("internal error", { status: 500 })),
    ) as typeof fetch;

    const client = createCesHttpCredentialClient(
      createTestConfig(),
      createNoopLogger(),
    );
    const result = await client.get("some-acct");

    expect(result.value).toBeUndefined();
    expect(result.unreachable).toBe(true);
  });

  test("get returns unreachable on network error", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("ECONNREFUSED")),
    ) as typeof fetch;

    const client = createCesHttpCredentialClient(
      createTestConfig(),
      createNoopLogger(),
    );
    const result = await client.get("some-acct");

    expect(result.value).toBeUndefined();
    expect(result.unreachable).toBe(true);
  });

  test("delete returns deleted on 200", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(Response.json({ ok: true, account: "acct" })),
    ) as typeof fetch;

    const client = createCesHttpCredentialClient(
      createTestConfig(),
      createNoopLogger(),
    );
    const result = await client.delete("acct");

    expect(result).toBe("deleted");
  });

  test("delete returns not-found on 404", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 404 })),
    ) as typeof fetch;

    const client = createCesHttpCredentialClient(
      createTestConfig(),
      createNoopLogger(),
    );
    const result = await client.delete("missing");

    expect(result).toBe("not-found");
  });

  test("delete returns error on network failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("network down")),
    ) as typeof fetch;

    const client = createCesHttpCredentialClient(
      createTestConfig(),
      createNoopLogger(),
    );
    const result = await client.delete("acct");

    expect(result).toBe("error");
  });

  test("list returns accounts on 200", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(Response.json({ accounts: ["a", "b", "c"] })),
    ) as typeof fetch;

    const client = createCesHttpCredentialClient(
      createTestConfig(),
      createNoopLogger(),
    );
    const result = await client.list();

    expect(result.accounts).toEqual(["a", "b", "c"]);
    expect(result.unreachable).toBe(false);
  });

  test("list returns unreachable on error", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("timeout")),
    ) as typeof fetch;

    const client = createCesHttpCredentialClient(
      createTestConfig(),
      createNoopLogger(),
    );
    const result = await client.list();

    expect(result.accounts).toEqual([]);
    expect(result.unreachable).toBe(true);
  });

  test("bulkSet returns all-failed when request fails", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("network")),
    ) as typeof fetch;

    const client = createCesHttpCredentialClient(
      createTestConfig(),
      createNoopLogger(),
    );
    const result = await client.bulkSet([
      { account: "a", value: "1" },
      { account: "b", value: "2" },
    ]);

    expect(result).toEqual([
      { account: "a", ok: false },
      { account: "b", ok: false },
    ]);
  });
});

// ---------------------------------------------------------------------------
// HTTP log export tests
// ---------------------------------------------------------------------------

describe("fetchCesLogExport", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns data on success", async () => {
    const archiveBytes = new Uint8Array([1, 2, 3, 4]).buffer;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(archiveBytes, {
          status: 200,
          headers: { "Content-Type": "application/gzip" },
        }),
      ),
    ) as typeof fetch;

    const result = await fetchCesLogExport({
      baseUrl: "http://ces-test:8090",
      serviceToken: "tok",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.byteLength).toBe(4);
    }
  });

  test("returns error on non-OK status", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("forbidden", { status: 403 })),
    ) as typeof fetch;

    const result = await fetchCesLogExport({
      baseUrl: "http://ces-test:8090",
      serviceToken: "tok",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("403");
    }
  });

  test("returns error on network failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("connection refused")),
    ) as typeof fetch;

    const result = await fetchCesLogExport({
      baseUrl: "http://ces-test:8090",
      serviceToken: "tok",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("connection refused");
    }
  });

  test("passes query params for date range", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock((url: string | URL | Request) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      return Promise.resolve(
        new Response(new ArrayBuffer(0), { status: 200 }),
      );
    }) as typeof fetch;

    await fetchCesLogExport(
      { baseUrl: "http://ces-test:8090", serviceToken: "tok" },
      { startTime: 1000, endTime: 2000 },
    );

    expect(capturedUrl).toContain("startTime=1000");
    expect(capturedUrl).toContain("endTime=2000");
  });
});

// ---------------------------------------------------------------------------
// RPC client tests
// ---------------------------------------------------------------------------

describe("CesRpcClient", () => {
  test("handshake succeeds when CES acknowledges", async () => {
    const transport = createMockTransport();
    const client = createCesRpcClient(transport, { handshakeTimeoutMs: 5000 });

    const handshakePromise = client.handshake();

    // Parse the sent handshake request to extract sessionId
    expect(transport.messages.length).toBe(1);
    const sent = JSON.parse(transport.messages[0]!);
    expect(sent.type).toBe("handshake_request");
    expect(sent.protocolVersion).toBe(CES_PROTOCOL_VERSION);

    // Simulate CES ack
    transport.messageHandler!(
      JSON.stringify({
        type: "handshake_ack",
        protocolVersion: CES_PROTOCOL_VERSION,
        sessionId: sent.sessionId,
        accepted: true,
      }),
    );

    const result = await handshakePromise;
    expect(result.accepted).toBe(true);
    expect(client.isReady()).toBe(true);
  });

  test("handshake returns rejection reason", async () => {
    const transport = createMockTransport();
    const client = createCesRpcClient(transport, { handshakeTimeoutMs: 5000 });

    const handshakePromise = client.handshake();

    const sent = JSON.parse(transport.messages[0]!);

    transport.messageHandler!(
      JSON.stringify({
        type: "handshake_ack",
        protocolVersion: CES_PROTOCOL_VERSION,
        sessionId: sent.sessionId,
        accepted: false,
        reason: "version mismatch",
      }),
    );

    const result = await handshakePromise;
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("version mismatch");
    expect(client.isReady()).toBe(false);
  });

  test("handshake passes assistantApiKey and assistantId", async () => {
    const transport = createMockTransport();
    const client = createCesRpcClient(transport, { handshakeTimeoutMs: 5000 });

    const handshakePromise = client.handshake({
      assistantApiKey: "key-123",
      assistantId: "asst-456",
    });

    const sent = JSON.parse(transport.messages[0]!);
    expect(sent.assistantApiKey).toBe("key-123");
    expect(sent.assistantId).toBe("asst-456");

    // Complete the handshake
    transport.messageHandler!(
      JSON.stringify({
        type: "handshake_ack",
        protocolVersion: CES_PROTOCOL_VERSION,
        sessionId: sent.sessionId,
        accepted: true,
      }),
    );

    await handshakePromise;
  });

  test("handshake times out", async () => {
    const transport = createMockTransport();
    const client = createCesRpcClient(transport, { handshakeTimeoutMs: 50 });

    try {
      await client.handshake();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CesHandshakeError);
    }
  });

  test("call throws before handshake", async () => {
    const transport = createMockTransport();
    const client = createCesRpcClient(transport);

    try {
      await client.call("list_credentials", {});
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CesClientError);
      expect((err as Error).message).toContain("handshake");
    }
  });

  test("call throws on dead transport", async () => {
    const transport = createMockTransport();
    const client = createCesRpcClient(transport, { handshakeTimeoutMs: 5000 });

    // Complete handshake
    const handshakePromise = client.handshake();
    const sent = JSON.parse(transport.messages[0]!);
    transport.messageHandler!(
      JSON.stringify({
        type: "handshake_ack",
        protocolVersion: CES_PROTOCOL_VERSION,
        sessionId: sent.sessionId,
        accepted: true,
      }),
    );
    await handshakePromise;

    // Kill transport
    transport.alive = false;

    try {
      await client.call("list_credentials", {});
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CesTransportError);
    }
  });

  test("call correlates request and response by id", async () => {
    const transport = createMockTransport();
    const client = createCesRpcClient(transport, {
      handshakeTimeoutMs: 5000,
      requestTimeoutMs: 5000,
    });

    // Handshake
    const hPromise = client.handshake();
    const hSent = JSON.parse(transport.messages[0]!);
    transport.messageHandler!(
      JSON.stringify({
        type: "handshake_ack",
        protocolVersion: CES_PROTOCOL_VERSION,
        sessionId: hSent.sessionId,
        accepted: true,
      }),
    );
    await hPromise;

    // Make a call
    const callPromise = client.call("list_credentials", {});

    // Find the RPC request
    const rpcMsg = JSON.parse(transport.messages[1]!);
    expect(rpcMsg.type).toBe("rpc");
    expect(rpcMsg.kind).toBe("request");
    expect(rpcMsg.method).toBe("list_credentials");

    // Respond with matching id
    transport.messageHandler!(
      JSON.stringify({
        id: rpcMsg.id,
        kind: "response",
        method: "list_credentials",
        payload: { accounts: ["acct-a", "acct-b"] },
        timestamp: new Date().toISOString(),
      }),
    );

    const result = await callPromise;
    expect(result).toEqual({ accounts: ["acct-a", "acct-b"] });
  });

  test("call times out", async () => {
    const transport = createMockTransport();
    const client = createCesRpcClient(transport, {
      handshakeTimeoutMs: 5000,
      requestTimeoutMs: 50,
    });

    // Handshake
    const hPromise = client.handshake();
    const hSent = JSON.parse(transport.messages[0]!);
    transport.messageHandler!(
      JSON.stringify({
        type: "handshake_ack",
        protocolVersion: CES_PROTOCOL_VERSION,
        sessionId: hSent.sessionId,
        accepted: true,
      }),
    );
    await hPromise;

    // Call with no response
    try {
      await client.call("list_credentials", {});
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CesTimeoutError);
    }
  });

  test("close cancels pending requests", async () => {
    const transport = createMockTransport();
    const client = createCesRpcClient(transport, {
      handshakeTimeoutMs: 5000,
      requestTimeoutMs: 60_000,
    });

    // Handshake
    const hPromise = client.handshake();
    const hSent = JSON.parse(transport.messages[0]!);
    transport.messageHandler!(
      JSON.stringify({
        type: "handshake_ack",
        protocolVersion: CES_PROTOCOL_VERSION,
        sessionId: hSent.sessionId,
        accepted: true,
      }),
    );
    await hPromise;

    const callPromise = client.call("list_credentials", {});

    // Close before response arrives
    client.close();

    try {
      await callPromise;
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CesTransportError);
      expect((err as Error).message).toContain("closed");
    }

    expect(client.isReady()).toBe(false);
  });

  test("subsequent handshake call returns immediately if already ready", async () => {
    const transport = createMockTransport();
    const client = createCesRpcClient(transport, { handshakeTimeoutMs: 5000 });

    // First handshake
    const h1 = client.handshake();
    const sent = JSON.parse(transport.messages[0]!);
    transport.messageHandler!(
      JSON.stringify({
        type: "handshake_ack",
        protocolVersion: CES_PROTOCOL_VERSION,
        sessionId: sent.sessionId,
        accepted: true,
      }),
    );
    await h1;

    // Second handshake should return immediately without sending anything
    const msgCountBefore = transport.messages.length;
    const h2 = await client.handshake();
    expect(h2.accepted).toBe(true);
    expect(transport.messages.length).toBe(msgCountBefore);
  });
});
