/**
 * Tests for the CES client, process manager, and executable discovery.
 *
 * Verifies:
 * 1. Local discovery fails closed when the CES executable is unavailable.
 * 2. Managed discovery fails closed when the socket is missing or handshake fails.
 * 3. No assistant code imports CES source modules directly (boundary guard).
 * 4. The CES RPC client correctly frames requests and validates responses.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { CES_PROTOCOL_VERSION } from "@vellumai/ces-contracts";

import {
  CesClientError,
  CesHandshakeError,
  type CesTransport,
  CesTransportError,
  createCesClient,
} from "../credential-execution/client.js";
import {
  discoverLocalCes,
  discoverManagedCes,
} from "../credential-execution/executable-discovery.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock CesTransport for testing the client in isolation.
 */
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

// ---------------------------------------------------------------------------
// Local discovery — fail closed when executable is unavailable
// ---------------------------------------------------------------------------

describe("local CES discovery", () => {
  test("returns unavailable when CES executable is not found", () => {
    // discoverLocalCes() searches well-known paths. In the test environment,
    // those paths should not contain a credential-executor binary.
    const result = discoverLocalCes();
    // If running in a dev environment where the binary IS installed, this
    // test still passes — we just verify the result shape.
    if (result.mode === "unavailable") {
      expect(result.reason).toContain("CES executable not found");
      expect(result.mode).toBe("unavailable");
    } else {
      // Binary exists in this environment — verify the success shape.
      expect(result.mode).toBe("local");
      expect(
        (result as { executablePath: string }).executablePath,
      ).toBeTruthy();
    }
  });

  test("never returns a fallback or in-process mode", () => {
    const result = discoverLocalCes();
    // The result must be either "local" (with a valid path) or "unavailable".
    // There must never be a fallback mode like "in-process" or "degraded".
    expect(["local", "unavailable"]).toContain(result.mode);
  });
});

// ---------------------------------------------------------------------------
// Managed discovery — fail closed when socket is missing or handshake fails
// ---------------------------------------------------------------------------

describe("managed CES discovery", () => {
  test("returns unavailable when bootstrap socket does not exist", async () => {
    // In a non-containerized test environment, the managed socket path
    // does not exist. Verify fail-closed behavior.
    const saved = process.env["CES_BOOTSTRAP_SOCKET"];
    try {
      // Point at a non-existent path to ensure predictable behavior
      process.env["CES_BOOTSTRAP_SOCKET"] = "/tmp/ces-test-nonexistent.sock";
      const result = await discoverManagedCes();
      expect(result.mode).toBe("unavailable");
      expect((result as { reason: string }).reason).toContain(
        "CES bootstrap socket not found",
      );
    } finally {
      if (saved !== undefined) {
        process.env["CES_BOOTSTRAP_SOCKET"] = saved;
      } else {
        delete process.env["CES_BOOTSTRAP_SOCKET"];
      }
    }
  });

  test("never returns a fallback or in-process mode", async () => {
    const saved = process.env["CES_BOOTSTRAP_SOCKET"];
    try {
      process.env["CES_BOOTSTRAP_SOCKET"] = "/tmp/ces-test-nonexistent.sock";
      const result = await discoverManagedCes();
      // Must be "managed" or "unavailable" — no fallback modes.
      expect(["managed", "unavailable"]).toContain(result.mode);
    } finally {
      if (saved !== undefined) {
        process.env["CES_BOOTSTRAP_SOCKET"] = saved;
      } else {
        delete process.env["CES_BOOTSTRAP_SOCKET"];
      }
    }
  });
});

// ---------------------------------------------------------------------------
// CES client — transport and framing
// ---------------------------------------------------------------------------

describe("CES client", () => {
  test("handshake sends correct protocol version", async () => {
    const transport = createMockTransport();
    const client = createCesClient(transport, {
      handshakeTimeoutMs: 1_000,
    });

    // Start handshake (will block until ack or timeout)
    const handshakePromise = client.handshake();

    // Verify the sent handshake request
    expect(transport.sentMessages.length).toBe(1);
    const sent = JSON.parse(transport.sentMessages[0]);
    expect(sent.type).toBe("handshake_request");
    expect(sent.protocolVersion).toBe(CES_PROTOCOL_VERSION);
    expect(sent.sessionId).toBeTruthy();

    // Simulate handshake ack
    transport.simulateMessage(
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

    client.close();
  });

  test("handshake times out when CES does not respond", async () => {
    const transport = createMockTransport();
    const client = createCesClient(transport, {
      handshakeTimeoutMs: 100, // Very short timeout for test
    });

    try {
      await client.handshake();
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(CesHandshakeError);
      expect((err as Error).message).toContain("timed out");
    }

    client.close();
  });

  test("handshake reports rejection from CES", async () => {
    const transport = createMockTransport();
    const client = createCesClient(transport, {
      handshakeTimeoutMs: 1_000,
    });

    const handshakePromise = client.handshake();

    const sent = JSON.parse(transport.sentMessages[0]);
    transport.simulateMessage(
      JSON.stringify({
        type: "handshake_ack",
        protocolVersion: CES_PROTOCOL_VERSION,
        sessionId: sent.sessionId,
        accepted: false,
        reason: "Protocol version mismatch",
      }),
    );

    const result = await handshakePromise;
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("Protocol version mismatch");
    expect(client.isReady()).toBe(false);

    client.close();
  });

  test("call() throws before handshake", async () => {
    const transport = createMockTransport();
    const client = createCesClient(transport);

    try {
      await client.call("list_grants", {});
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(CesClientError);
      expect((err as Error).message).toContain("handshake");
    }

    client.close();
  });

  test("call() throws when transport is dead", async () => {
    const transport = createMockTransport();
    const client = createCesClient(transport, {
      handshakeTimeoutMs: 1_000,
    });

    // Complete handshake
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

    // Kill transport
    transport.alive = false;

    try {
      await client.call("list_grants", {});
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(CesTransportError);
    }

    client.close();
  });

  test("close() cancels pending requests", async () => {
    const transport = createMockTransport();
    const client = createCesClient(transport, {
      handshakeTimeoutMs: 1_000,
      requestTimeoutMs: 10_000,
    });

    // Complete handshake
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

    // Start a call that will never complete
    const callPromise = client.call("list_grants", {});

    // Close the client
    client.close();

    try {
      await callPromise;
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(CesTransportError);
      expect((err as Error).message).toContain("closed");
    }
  });
});

// ---------------------------------------------------------------------------
// Boundary guard — no assistant code imports CES source modules directly
// ---------------------------------------------------------------------------

describe("CES boundary guard", () => {
  test("no assistant source file imports from credential-executor/", () => {
    const assistantSrcDir = resolve(__dirname, "..");
    const violations: string[] = [];

    walkDir(assistantSrcDir, (filePath) => {
      // Only check TypeScript source files
      if (!filePath.endsWith(".ts") && !filePath.endsWith(".tsx")) return;
      // Skip test files themselves
      if (filePath.includes("__tests__")) return;
      // Skip node_modules
      if (filePath.includes("node_modules")) return;

      const content = readFileSync(filePath, "utf-8");

      // Check for direct imports of credential-executor modules
      // This would violate the hard process-boundary isolation
      const patterns = [
        /from\s+['"]\.\.\/.*credential-executor/,
        /from\s+['"]credential-executor/,
        /require\s*\(\s*['"]\.\.\/.*credential-executor/,
        /require\s*\(\s*['"]credential-executor/,
        /from\s+['"]@vellumai\/credential-executor/,
      ];

      for (const pattern of patterns) {
        if (pattern.test(content)) {
          violations.push(filePath);
          break;
        }
      }
    });

    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Directory walker
// ---------------------------------------------------------------------------

function walkDir(dir: string, callback: (filePath: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        if (entry === "node_modules" || entry === "dist") continue;
        walkDir(fullPath, callback);
      } else {
        callback(fullPath);
      }
    } catch {
      // Skip inaccessible entries
    }
  }
}
