/**
 * Tests for the CES client, process manager, and executable discovery.
 *
 * Verifies:
 * 1. Local discovery fails closed when the CES executable is unavailable.
 * 2. Managed discovery fails closed when the socket is missing or handshake fails.
 * 3. No assistant code imports CES source modules directly (boundary guard).
 * 4. The CES RPC client correctly frames requests and validates responses.
 */

import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { resolveIpcEndpoint } from "@vellumai/ipc-server-utils";
import { CES_PROTOCOL_VERSION } from "@vellumai/service-contracts/credential-rpc";

import {
  CesClientError,
  CesHandshakeError,
  type CesTransport,
  CesTransportError,
  createCesClient,
} from "../credential-execution/client.js";
import {
  discoverCes,
  discoverCesWithRetry,
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
// CES discovery — CES_BOOTSTRAP_SOCKET_DIR, not workspace
// ---------------------------------------------------------------------------

function withBootstrapDir(dir: string): () => void {
  const savedDir = process.env["CES_BOOTSTRAP_SOCKET_DIR"];
  process.env["CES_BOOTSTRAP_SOCKET_DIR"] = dir;
  return () => {
    if (savedDir !== undefined) {
      process.env["CES_BOOTSTRAP_SOCKET_DIR"] = savedDir;
    } else {
      delete process.env["CES_BOOTSTRAP_SOCKET_DIR"];
    }
  };
}

describe("CES discovery", () => {
  test("returns unavailable when bootstrap socket does not exist", () => {
    const bootstrapDir = mkdtempSync(join(tmpdir(), "ces-missing-"));
    const restore = withBootstrapDir(bootstrapDir);
    try {
      const result = discoverCes();
      expect(result.mode).toBe("unavailable");
      expect((result as { reason: string }).reason).toContain(
        "CES bootstrap socket not found",
      );
    } finally {
      restore();
      rmSync(bootstrapDir, { recursive: true, force: true });
    }
  });

  test("never returns a fallback or in-process mode", () => {
    const bootstrapDir = mkdtempSync(join(tmpdir(), "ces-missing-"));
    const restore = withBootstrapDir(bootstrapDir);
    try {
      const result = discoverCes();
      expect(["managed", "unavailable"]).toContain(result.mode);
    } finally {
      restore();
      rmSync(bootstrapDir, { recursive: true, force: true });
    }
  });
});

describe("CES bootstrap socket discovery", () => {
  test("looks for the socket under CES_BOOTSTRAP_SOCKET_DIR", () => {
    const bootstrapDir = mkdtempSync(join(tmpdir(), "ces-bootstrap-"));
    const restore = withBootstrapDir(bootstrapDir);
    try {
      const socketPath = resolveIpcEndpoint("ces", {
        workspaceDir: bootstrapDir,
      }).path;
      const result = discoverCes();
      expect(result.mode).toBe("unavailable");
      expect((result as { reason: string }).reason).toContain(socketPath);
    } finally {
      restore();
      rmSync(bootstrapDir, { recursive: true, force: true });
    }
  });

  test("does not discover CES from VELLUM_WORKSPACE_DIR", () => {
    const bootstrapDir = mkdtempSync(join(tmpdir(), "ces-bootstrap-"));
    const restore = withBootstrapDir(bootstrapDir);
    try {
      const result = discoverCes();
      const workspaceDir = process.env.VELLUM_WORKSPACE_DIR;
      expect(workspaceDir).toBeDefined();
      const workspaceSocket = resolveIpcEndpoint("ces", {
        workspaceDir: workspaceDir!,
      }).path;
      expect((result as { reason: string }).reason).not.toContain(
        workspaceSocket,
      );
    } finally {
      restore();
      rmSync(bootstrapDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Managed discovery retry — absorbs the sidecar's socket re-bind window
// ---------------------------------------------------------------------------

describe("discoverCesWithRetry", () => {
  test("returns unavailable after polling when the socket never appears", async () => {
    const bootstrapDir = mkdtempSync(join(tmpdir(), "ces-retry-missing-"));
    const restore = withBootstrapDir(bootstrapDir);
    try {
      const start = Date.now();
      const result = await discoverCesWithRetry({
        timeoutMs: 200,
        intervalMs: 20,
      });
      expect(result.mode).toBe("unavailable");
      expect(Date.now() - start).toBeGreaterThanOrEqual(150);
    } finally {
      restore();
      rmSync(bootstrapDir, { recursive: true, force: true });
    }
  });

  test("resolves to managed once the socket is re-bound mid-poll", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ces-retry-"));
    const socketPath = resolveIpcEndpoint("ces", { workspaceDir: dir }).path;
    const restore = withBootstrapDir(dir);
    const timer = setTimeout(() => writeFileSync(socketPath, ""), 80);
    try {
      const result = await discoverCesWithRetry({
        timeoutMs: 2_000,
        intervalMs: 20,
      });
      expect(result.mode).toBe("managed");
      expect((result as { socketPath: string }).socketPath).toBe(socketPath);
    } finally {
      clearTimeout(timer);
      restore();
      rmSync(dir, { recursive: true, force: true });
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
      await client.call("list_credentials", {});
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
      await client.call("list_credentials", {});
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
    const callPromise = client.call("list_credentials", {});

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
      if (!filePath.endsWith(".ts") && !filePath.endsWith(".tsx")) {
        return;
      }
      // Skip test files themselves
      if (filePath.includes("__tests__")) {
        return;
      }
      // Skip node_modules
      if (filePath.includes("node_modules")) {
        return;
      }

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
        if (entry === "node_modules" || entry === "dist") {
          continue;
        }
        walkDir(fullPath, callback);
      } else {
        callback(fullPath);
      }
    } catch {
      // Skip inaccessible entries
    }
  }
}
