import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Mock logger to silence output
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_DIR = join(
  tmpdir(),
  `vellum-broker-test-${randomBytes(4).toString("hex")}`,
);
const TOKEN_DIR = join(TEST_DIR, ".vellum", "protected");
const TOKEN_PATH = join(TOKEN_DIR, "keychain-broker.token");
const SOCKET_PATH = join(TEST_DIR, ".vellum", "keychain-broker.sock");
const TEST_TOKEN = "test-auth-token-abc123";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock UDS server that speaks the broker protocol.
 * Returns the server and a handler setter for customizing responses.
 */
function createMockBroker(): {
  server: Server;
  setHandler: (
    fn: (request: Record<string, unknown>) => Record<string, unknown>,
  ) => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  let handler: (
    request: Record<string, unknown>,
  ) => Record<string, unknown> = () => ({ ok: true });

  const connections = new Set<import("node:net").Socket>();

  const server = createServer((conn) => {
    connections.add(conn);
    conn.on("close", () => connections.delete(conn));
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const request = JSON.parse(line);
          const response = handler(request);
          conn.write(JSON.stringify({ id: request.id, ...response }) + "\n");
        } catch {
          // Malformed request — ignore
        }
      }
    });
  });

  return {
    server,
    setHandler: (fn) => {
      handler = fn;
    },
    start: () =>
      new Promise<void>((resolve) => {
        server.listen(SOCKET_PATH, () => resolve());
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        // Destroy active connections so server.close() can complete
        for (const conn of connections) conn.destroy();
        connections.clear();
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
  mkdirSync(TOKEN_DIR, { recursive: true });
});

beforeEach(() => {
  // Clean up socket file from prior test
  try {
    rmSync(SOCKET_PATH, { force: true });
  } catch {
    /* ignore */
  }
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Mock platform to point getRootDir at our test directory
// ---------------------------------------------------------------------------

mock.module("../util/platform.js", () => ({
  getRootDir: () => join(TEST_DIR, ".vellum"),
  isMacOS: () => true,
  getPlatformName: () => "darwin",
}));

// Import after mocks are set up
const { createBrokerClient } =
  await import("../security/keychain-broker-client.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("keychain-broker-client", () => {
  // -----------------------------------------------------------------------
  // isAvailable()
  // -----------------------------------------------------------------------
  describe("isAvailable", () => {
    test("returns false when socket file does not exist", () => {
      writeFileSync(TOKEN_PATH, TEST_TOKEN);
      const client = createBrokerClient();
      expect(client.isAvailable()).toBe(false);
    });

    test("returns false when token file does not exist", () => {
      // Create the socket file so that check passes
      writeFileSync(SOCKET_PATH, "");
      try {
        rmSync(TOKEN_PATH, { force: true });
      } catch {
        /* ignore */
      }
      const client = createBrokerClient();
      expect(client.isAvailable()).toBe(false);
    });

    test("returns true when both socket file and token file exist", () => {
      writeFileSync(SOCKET_PATH, "");
      writeFileSync(TOKEN_PATH, TEST_TOKEN);
      const client = createBrokerClient();
      expect(client.isAvailable()).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Request/response serialization
  // -----------------------------------------------------------------------
  describe("request/response", () => {
    let broker: ReturnType<typeof createMockBroker>;

    beforeEach(async () => {
      writeFileSync(TOKEN_PATH, TEST_TOKEN);
      broker = createMockBroker();
    });

    afterEach(async () => {
      await broker.stop();
    });

    test("ping returns pong from broker", async () => {
      broker.setHandler((req) => {
        expect(req.v).toBe(1);
        if (req.method === "broker.ping") {
          return { ok: true, result: { pong: true } };
        }
        return {
          ok: false,
          error: { code: "INVALID_REQUEST", message: "unknown method" },
        };
      });
      await broker.start();

      const client = createBrokerClient();
      const result = await client.ping();
      expect(result).toEqual({ pong: true });
    });

    test("get returns found result from broker", async () => {
      broker.setHandler((req) => {
        expect(req.v).toBe(1);
        const params = req.params as { account?: string } | undefined;
        if (req.method === "key.get" && params?.account === "my-key") {
          return { ok: true, result: { found: true, value: "secret-value" } };
        }
        return {
          ok: false,
          error: { code: "INVALID_REQUEST", message: "not found" },
        };
      });
      await broker.start();

      const client = createBrokerClient();
      const result = await client.get("my-key");
      expect(result).toEqual({ found: true, value: "secret-value" });
    });

    test("get returns not-found result from broker", async () => {
      broker.setHandler((req) => {
        expect(req.v).toBe(1);
        if (req.method === "key.get") {
          return { ok: true, result: { found: false } };
        }
        return {
          ok: false,
          error: { code: "INVALID_REQUEST", message: "bad" },
        };
      });
      await broker.start();

      const client = createBrokerClient();
      const result = await client.get("missing-key");
      expect(result).toEqual({ found: false, value: undefined });
    });

    test("set returns true on success", async () => {
      broker.setHandler((req) => {
        expect(req.v).toBe(1);
        const params = req.params as
          | { account?: string; value?: string }
          | undefined;
        if (
          req.method === "key.set" &&
          params?.account === "my-key" &&
          params?.value === "new-value"
        ) {
          return { ok: true, result: { stored: true } };
        }
        return {
          ok: false,
          error: { code: "INVALID_REQUEST", message: "failed" },
        };
      });
      await broker.start();

      const client = createBrokerClient();
      const result = await client.set("my-key", "new-value");
      expect(result).toEqual({ status: "ok" });
    });

    test("del returns true on success", async () => {
      broker.setHandler((req) => {
        expect(req.v).toBe(1);
        const params = req.params as { account?: string } | undefined;
        if (req.method === "key.delete" && params?.account === "my-key") {
          return { ok: true, result: { deleted: true } };
        }
        return {
          ok: false,
          error: { code: "INVALID_REQUEST", message: "not found" },
        };
      });
      await broker.start();

      const client = createBrokerClient();
      const result = await client.del("my-key");
      expect(result).toBe(true);
    });

    test("list returns account names", async () => {
      broker.setHandler((req) => {
        expect(req.v).toBe(1);
        if (req.method === "key.list") {
          return {
            ok: true,
            result: { accounts: ["key-a", "key-b", "key-c"] },
          };
        }
        return {
          ok: false,
          error: { code: "INVALID_REQUEST", message: "failed" },
        };
      });
      await broker.start();

      const client = createBrokerClient();
      const result = await client.list();
      expect(result).toEqual(["key-a", "key-b", "key-c"]);
    });

    test("sends auth token and v:1 with every request", async () => {
      let receivedToken: unknown;
      let receivedVersion: unknown;
      broker.setHandler((req) => {
        receivedToken = req.token;
        receivedVersion = req.v;
        return { ok: true, result: { pong: true } };
      });
      await broker.start();

      const client = createBrokerClient();
      await client.ping();
      expect(receivedToken).toBe(TEST_TOKEN);
      expect(receivedVersion).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Timeout handling
  // -----------------------------------------------------------------------
  describe("timeout", () => {
    let broker: ReturnType<typeof createMockBroker>;

    beforeEach(async () => {
      writeFileSync(TOKEN_PATH, TEST_TOKEN);
      broker = createMockBroker();
    });

    afterEach(async () => {
      await broker.stop();
    });

    test("returns graceful fallback when broker does not respond within timeout", async () => {
      // Handler that never responds
      broker.setHandler(() => {
        // Intentionally do not return a response — the broker mock won't send anything
        return undefined as unknown as Record<string, unknown>;
      });

      // Override handler at the server level to swallow requests
      broker.server.removeAllListeners("connection");
      broker.server.on("connection", (_conn) => {
        // Accept connection but never respond
      });
      await broker.start();

      const client = createBrokerClient();

      // get should return null on timeout (broker error)
      const result = await client.get("test-key");
      expect(result).toBeNull();
    }, 10_000);
  });

  // -----------------------------------------------------------------------
  // UNAUTHORIZED -> token re-read -> retry
  // -----------------------------------------------------------------------
  describe("UNAUTHORIZED retry", () => {
    let broker: ReturnType<typeof createMockBroker>;

    beforeEach(async () => {
      writeFileSync(TOKEN_PATH, "old-token");
      broker = createMockBroker();
    });

    afterEach(async () => {
      await broker.stop();
    });

    test("re-reads token and retries on UNAUTHORIZED", async () => {
      let callCount = 0;
      broker.setHandler((req) => {
        callCount++;
        if (req.token === "new-token") {
          return { ok: true, result: { pong: true } };
        }
        return {
          ok: false,
          error: { code: "UNAUTHORIZED", message: "Invalid auth token" },
        };
      });
      await broker.start();

      const client = createBrokerClient();

      // First call will use "old-token" and get UNAUTHORIZED.
      // Simulate the token file being updated before the retry.
      // We need to update it after the first request but before the retry.
      // Since the handler runs synchronously, update the file in the handler.
      broker.setHandler((req) => {
        callCount++;
        if (callCount === 1) {
          // First request with old token — write new token file and return UNAUTHORIZED
          writeFileSync(TOKEN_PATH, "new-token");
          return {
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Invalid auth token" },
          };
        }
        // Retry with re-read token
        if (req.token === "new-token") {
          return { ok: true, result: { pong: true } };
        }
        return {
          ok: false,
          error: { code: "UNAUTHORIZED", message: "Invalid auth token" },
        };
      });
      callCount = 0;

      const result = await client.ping();
      expect(result).toEqual({ pong: true });
      expect(callCount).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Graceful degradation
  // -----------------------------------------------------------------------
  describe("graceful degradation", () => {
    test("get returns null when socket file does not exist", async () => {
      writeFileSync(TOKEN_PATH, TEST_TOKEN);
      const client = createBrokerClient();
      const result = await client.get("test-key");
      expect(result).toBeNull();
    });

    test("set returns unreachable when socket file does not exist", async () => {
      writeFileSync(TOKEN_PATH, TEST_TOKEN);
      const client = createBrokerClient();
      const result = await client.set("test-key", "value");
      expect(result).toEqual({ status: "unreachable" });
    });

    test("del returns false when socket file does not exist", async () => {
      writeFileSync(TOKEN_PATH, TEST_TOKEN);
      const client = createBrokerClient();
      const result = await client.del("test-key");
      expect(result).toBe(false);
    });

    test("list returns empty array when socket file does not exist", async () => {
      writeFileSync(TOKEN_PATH, TEST_TOKEN);
      const client = createBrokerClient();
      const result = await client.list();
      expect(result).toEqual([]);
    });

    test("ping returns null when socket file does not exist", async () => {
      writeFileSync(TOKEN_PATH, TEST_TOKEN);
      const client = createBrokerClient();
      const result = await client.ping();
      expect(result).toBeNull();
    });

    test("returns fallbacks when token file is missing", async () => {
      try {
        rmSync(TOKEN_PATH, { force: true });
      } catch {
        /* ignore */
      }
      const client = createBrokerClient();
      expect(await client.get("key")).toBeNull();
      expect(await client.set("key", "val")).toEqual({ status: "unreachable" });
      expect(await client.del("key")).toBe(false);
      expect(await client.list()).toEqual([]);
      expect(await client.ping()).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Connection persistence
  // -----------------------------------------------------------------------
  describe("connection persistence", () => {
    let broker: ReturnType<typeof createMockBroker>;

    beforeEach(async () => {
      writeFileSync(TOKEN_PATH, TEST_TOKEN);
      broker = createMockBroker();
    });

    afterEach(async () => {
      await broker.stop();
    });

    test("reuses the same connection across multiple requests", async () => {
      let connectionCount = 0;
      broker.server.on("connection", () => {
        connectionCount++;
      });
      broker.setHandler(() => ({ ok: true, result: { pong: true } }));
      await broker.start();

      const client = createBrokerClient();
      await client.ping();
      await client.ping();
      await client.ping();

      expect(connectionCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Cooldown-based retry
  // -----------------------------------------------------------------------
  describe("cooldown-based retry", () => {
    const originalDateNow = Date.now;
    let fakeNow: number;

    beforeEach(() => {
      fakeNow = originalDateNow.call(Date);
      Date.now = () => fakeNow;
      writeFileSync(TOKEN_PATH, TEST_TOKEN);
    });

    afterEach(() => {
      Date.now = originalDateNow;
    });

    test("retries connection after cooldown period elapses", async () => {
      // No socket file — two connection failures (first + immediate retry)
      const client = createBrokerClient();
      const result = await client.ping();
      expect(result).toBeNull();

      // Client should be in cooldown — isAvailable() returns false even with
      // socket + token files present.
      writeFileSync(SOCKET_PATH, "");
      expect(client.isAvailable()).toBe(false);

      // Advance time past the first cooldown (5s)
      fakeNow += 5_001;
      expect(client.isAvailable()).toBe(true);

      // Now start a real broker and verify the client reconnects
      rmSync(SOCKET_PATH, { force: true });
      const broker = createMockBroker();
      broker.setHandler(() => ({ ok: true, result: { pong: true } }));
      await broker.start();

      const retryResult = await client.ping();
      expect(retryResult).toEqual({ pong: true });

      await broker.stop();
    });

    test("resets failure count after successful reconnection", async () => {
      // No socket file — two connection failures
      const client = createBrokerClient();
      await client.ping();

      // Advance past first cooldown (5s)
      fakeNow += 5_001;

      // Start broker — reconnection should succeed and reset counters
      const broker = createMockBroker();
      broker.setHandler(() => ({ ok: true, result: { pong: true } }));
      await broker.start();

      const result = await client.ping();
      expect(result).toEqual({ pong: true });

      // Stop broker and remove socket — simulate another disconnection.
      // Yield after stop so the client socket receives the close event
      // before the next ping (otherwise ensureConnected returns the stale
      // socket and sendRequest waits REQUEST_TIMEOUT_MS for a response).
      await broker.stop();
      await new Promise((r) => setTimeout(r, 50));
      rmSync(SOCKET_PATH, { force: true });

      // This new failure should start from the beginning of the cooldown
      // schedule (5s), not escalated.
      await client.ping();

      // Verify cooldown is back to 5s (not 15s)
      writeFileSync(SOCKET_PATH, "");
      expect(client.isAvailable()).toBe(false);

      // 5s should be enough to clear cooldown
      fakeNow += 5_001;
      expect(client.isAvailable()).toBe(true);
    }, 15_000);

    test("escalates cooldown on repeated failures", async () => {
      const client = createBrokerClient();

      // First failure round: two attempts (first + immediate retry) ->
      // consecutiveFailures=2, cooldown index = max(2-2,0) = 0 -> 5s.
      await client.ping();

      writeFileSync(SOCKET_PATH, "");
      expect(client.isAvailable()).toBe(false);

      // 5s should clear the first cooldown
      fakeNow += 5_001;
      expect(client.isAvailable()).toBe(true);

      // Remove socket to trigger another failure. After cooldown elapses,
      // ensureConnected clears unavailableSince and tries connect().
      // This failure increments consecutiveFailures to 3 (no immediate retry
      // since consecutiveFailures > 1 after increment).
      // Cooldown index = max(3-2,0) = 1 -> 15s.
      rmSync(SOCKET_PATH, { force: true });
      await client.ping();

      writeFileSync(SOCKET_PATH, "");
      expect(client.isAvailable()).toBe(false);

      fakeNow += 5_001;
      expect(client.isAvailable()).toBe(false); // 5s not enough

      fakeNow += 10_000; // total 15_001ms since this cooldown started
      expect(client.isAvailable()).toBe(true);

      // Another failure -> consecutiveFailures=4, index = max(4-2,0) = 2 -> 30s
      rmSync(SOCKET_PATH, { force: true });
      await client.ping();

      writeFileSync(SOCKET_PATH, "");
      expect(client.isAvailable()).toBe(false);

      fakeNow += 15_001;
      expect(client.isAvailable()).toBe(false);

      fakeNow += 15_000; // total 30_001ms
      expect(client.isAvailable()).toBe(true);

      // Another failure -> consecutiveFailures=5, index = max(5-2,0) = 3 -> 60s
      rmSync(SOCKET_PATH, { force: true });
      await client.ping();

      writeFileSync(SOCKET_PATH, "");
      expect(client.isAvailable()).toBe(false);

      fakeNow += 30_001;
      expect(client.isAvailable()).toBe(false);

      fakeNow += 30_000; // total 60_001ms
      expect(client.isAvailable()).toBe(true);

      // Another failure -> consecutiveFailures=6, index = min(max(6-2,0), 4) = 4 -> 300s (5min)
      rmSync(SOCKET_PATH, { force: true });
      await client.ping();

      writeFileSync(SOCKET_PATH, "");
      expect(client.isAvailable()).toBe(false);

      fakeNow += 60_001;
      expect(client.isAvailable()).toBe(false);

      fakeNow += 240_000; // total 300_001ms
      expect(client.isAvailable()).toBe(true);

      // Another failure -> consecutiveFailures=7, index = min(max(7-2,0), 4) = 4 -> 300s (capped)
      rmSync(SOCKET_PATH, { force: true });
      await client.ping();

      writeFileSync(SOCKET_PATH, "");
      expect(client.isAvailable()).toBe(false);

      fakeNow += 300_001;
      expect(client.isAvailable()).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Connect timeout
  // -----------------------------------------------------------------------
  describe("connect timeout", () => {
    let server: Server;

    afterEach(async () => {
      if (server) {
        const conns = new Set<import("node:net").Socket>();
        server.on("connection", (c) => conns.add(c));
        for (const c of conns) c.destroy();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    });

    test("returns null within bounded time when broker accepts but never responds", async () => {
      writeFileSync(TOKEN_PATH, TEST_TOKEN);

      // Create a server that accepts connections but never sends any data,
      // simulating an unresponsive broker. The OS-level connect succeeds
      // (so connect timeout won't fire), but the request will hit the
      // REQUEST_TIMEOUT (5s) since no response arrives.
      server = createServer(() => {
        // Accept connection but do nothing
      });
      await new Promise<void>((resolve) => {
        server.listen(SOCKET_PATH, () => resolve());
      });

      const client = createBrokerClient();
      const start = Date.now();

      // get() should resolve to null (timeout) within a bounded time,
      // not hang indefinitely.
      const result = await client.get("test-account");
      const elapsed = Date.now() - start;

      expect(result).toBeNull();
      // Should complete well under 10s (request timeout is 5s)
      expect(elapsed).toBeLessThan(10_000);
    }, 15_000);

    test("connect timeout fires when socket exists but connect never completes", async () => {
      writeFileSync(TOKEN_PATH, TEST_TOKEN);

      // Write a regular file at the socket path. createConnection to a
      // non-socket file triggers an immediate ENOTSOCK / ECONNREFUSED on
      // most platforms. This verifies the connect() promise rejects (via
      // error or timeout) and doesn't hang.
      writeFileSync(SOCKET_PATH, "not-a-socket");

      const client = createBrokerClient();
      const start = Date.now();

      const result = await client.get("test-account");
      const elapsed = Date.now() - start;

      expect(result).toBeNull();
      // Should resolve quickly (immediate error) or within connect timeout (3s x 2)
      expect(elapsed).toBeLessThan(10_000);

      // Client should have entered cooldown after failures
      expect(client.isAvailable()).toBe(false);
    }, 15_000);

    test("first cooldown after failure is 5s, not 30s", async () => {
      const originalDateNow = Date.now;
      let fakeNow = originalDateNow.call(Date);
      Date.now = () => fakeNow;

      try {
        writeFileSync(TOKEN_PATH, TEST_TOKEN);

        // No socket file — triggers two connection failures (first + immediate retry)
        const client = createBrokerClient();
        await client.ping();

        // Client should be in cooldown now
        writeFileSync(SOCKET_PATH, "");
        expect(client.isAvailable()).toBe(false);

        // After 4s (less than 5s), still in cooldown
        fakeNow += 4_000;
        expect(client.isAvailable()).toBe(false);

        // After 5s+1ms total, cooldown should have elapsed
        fakeNow += 1_001;
        expect(client.isAvailable()).toBe(true);
      } finally {
        Date.now = originalDateNow;
      }
    });
  });
});
