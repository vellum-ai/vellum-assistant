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
const SOCKET_PATH = join(TEST_DIR, "broker.sock");
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

let originalEnv: string | undefined;

beforeAll(() => {
  mkdirSync(TOKEN_DIR, { recursive: true });
});

beforeEach(() => {
  originalEnv = process.env.VELLUM_KEYCHAIN_BROKER_SOCKET;
  // Clean up socket file from prior test
  try {
    rmSync(SOCKET_PATH, { force: true });
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.VELLUM_KEYCHAIN_BROKER_SOCKET;
  } else {
    process.env.VELLUM_KEYCHAIN_BROKER_SOCKET = originalEnv;
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
    test("returns false when env var is unset", () => {
      delete process.env.VELLUM_KEYCHAIN_BROKER_SOCKET;
      writeFileSync(TOKEN_PATH, TEST_TOKEN);
      const client = createBrokerClient();
      expect(client.isAvailable()).toBe(false);
    });

    test("returns false when token file does not exist", () => {
      process.env.VELLUM_KEYCHAIN_BROKER_SOCKET = SOCKET_PATH;
      try {
        rmSync(TOKEN_PATH, { force: true });
      } catch {
        /* ignore */
      }
      const client = createBrokerClient();
      expect(client.isAvailable()).toBe(false);
    });

    test("returns true when both env var and token file exist", () => {
      process.env.VELLUM_KEYCHAIN_BROKER_SOCKET = SOCKET_PATH;
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
      process.env.VELLUM_KEYCHAIN_BROKER_SOCKET = SOCKET_PATH;
      writeFileSync(TOKEN_PATH, TEST_TOKEN);
      broker = createMockBroker();
    });

    afterEach(async () => {
      await broker.stop();
    });

    test("ping returns version from broker", async () => {
      broker.setHandler((req) => {
        if (req.method === "ping") {
          return { ok: true, version: "1.0.0" };
        }
        return { ok: false, error: "unknown method" };
      });
      await broker.start();

      const client = createBrokerClient();
      const result = await client.ping();
      expect(result).toEqual({ version: "1.0.0" });
    });

    test("get returns value from broker", async () => {
      broker.setHandler((req) => {
        if (req.method === "get" && req.account === "my-key") {
          return { ok: true, value: "secret-value" };
        }
        return { ok: false, error: "not found" };
      });
      await broker.start();

      const client = createBrokerClient();
      const result = await client.get("my-key");
      expect(result).toBe("secret-value");
    });

    test("set returns true on success", async () => {
      broker.setHandler((req) => {
        if (
          req.method === "set" &&
          req.account === "my-key" &&
          req.value === "new-value"
        ) {
          return { ok: true };
        }
        return { ok: false, error: "failed" };
      });
      await broker.start();

      const client = createBrokerClient();
      const result = await client.set("my-key", "new-value");
      expect(result).toBe(true);
    });

    test("del returns true on success", async () => {
      broker.setHandler((req) => {
        if (req.method === "del" && req.account === "my-key") {
          return { ok: true };
        }
        return { ok: false, error: "not found" };
      });
      await broker.start();

      const client = createBrokerClient();
      const result = await client.del("my-key");
      expect(result).toBe(true);
    });

    test("list returns account names", async () => {
      broker.setHandler((req) => {
        if (req.method === "list") {
          return { ok: true, accounts: ["key-a", "key-b", "key-c"] };
        }
        return { ok: false, error: "failed" };
      });
      await broker.start();

      const client = createBrokerClient();
      const result = await client.list();
      expect(result).toEqual(["key-a", "key-b", "key-c"]);
    });

    test("sends auth token with every request", async () => {
      let receivedToken: unknown;
      broker.setHandler((req) => {
        receivedToken = req.token;
        return { ok: true, version: "1.0.0" };
      });
      await broker.start();

      const client = createBrokerClient();
      await client.ping();
      expect(receivedToken).toBe(TEST_TOKEN);
    });
  });

  // -----------------------------------------------------------------------
  // Timeout handling
  // -----------------------------------------------------------------------
  describe("timeout", () => {
    let broker: ReturnType<typeof createMockBroker>;

    beforeEach(async () => {
      process.env.VELLUM_KEYCHAIN_BROKER_SOCKET = SOCKET_PATH;
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

      // get should return undefined on timeout
      const result = await client.get("test-key");
      expect(result).toBeUndefined();
    }, 10_000);
  });

  // -----------------------------------------------------------------------
  // UNAUTHORIZED -> token re-read -> retry
  // -----------------------------------------------------------------------
  describe("UNAUTHORIZED retry", () => {
    let broker: ReturnType<typeof createMockBroker>;

    beforeEach(async () => {
      process.env.VELLUM_KEYCHAIN_BROKER_SOCKET = SOCKET_PATH;
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
          return { ok: true, version: "2.0.0" };
        }
        return { ok: false, error: "UNAUTHORIZED" };
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
          return { ok: false, error: "UNAUTHORIZED" };
        }
        // Retry with re-read token
        if (req.token === "new-token") {
          return { ok: true, version: "2.0.0" };
        }
        return { ok: false, error: "UNAUTHORIZED" };
      });
      callCount = 0;

      const result = await client.ping();
      expect(result).toEqual({ version: "2.0.0" });
      expect(callCount).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Graceful degradation
  // -----------------------------------------------------------------------
  describe("graceful degradation", () => {
    test("get returns undefined when broker is not running", async () => {
      process.env.VELLUM_KEYCHAIN_BROKER_SOCKET = SOCKET_PATH;
      writeFileSync(TOKEN_PATH, TEST_TOKEN);
      const client = createBrokerClient();
      const result = await client.get("test-key");
      expect(result).toBeUndefined();
    });

    test("set returns false when broker is not running", async () => {
      process.env.VELLUM_KEYCHAIN_BROKER_SOCKET = SOCKET_PATH;
      writeFileSync(TOKEN_PATH, TEST_TOKEN);
      const client = createBrokerClient();
      const result = await client.set("test-key", "value");
      expect(result).toBe(false);
    });

    test("del returns false when broker is not running", async () => {
      process.env.VELLUM_KEYCHAIN_BROKER_SOCKET = SOCKET_PATH;
      writeFileSync(TOKEN_PATH, TEST_TOKEN);
      const client = createBrokerClient();
      const result = await client.del("test-key");
      expect(result).toBe(false);
    });

    test("list returns empty array when broker is not running", async () => {
      process.env.VELLUM_KEYCHAIN_BROKER_SOCKET = SOCKET_PATH;
      writeFileSync(TOKEN_PATH, TEST_TOKEN);
      const client = createBrokerClient();
      const result = await client.list();
      expect(result).toEqual([]);
    });

    test("ping returns null when broker is not running", async () => {
      process.env.VELLUM_KEYCHAIN_BROKER_SOCKET = SOCKET_PATH;
      writeFileSync(TOKEN_PATH, TEST_TOKEN);
      const client = createBrokerClient();
      const result = await client.ping();
      expect(result).toBeNull();
    });

    test("returns fallbacks when socket path env var is unset", async () => {
      delete process.env.VELLUM_KEYCHAIN_BROKER_SOCKET;
      writeFileSync(TOKEN_PATH, TEST_TOKEN);
      const client = createBrokerClient();
      expect(await client.get("key")).toBeUndefined();
      expect(await client.set("key", "val")).toBe(false);
      expect(await client.del("key")).toBe(false);
      expect(await client.list()).toEqual([]);
      expect(await client.ping()).toBeNull();
    });

    test("returns fallbacks when token file is missing", async () => {
      process.env.VELLUM_KEYCHAIN_BROKER_SOCKET = SOCKET_PATH;
      try {
        rmSync(TOKEN_PATH, { force: true });
      } catch {
        /* ignore */
      }
      const client = createBrokerClient();
      expect(await client.get("key")).toBeUndefined();
      expect(await client.set("key", "val")).toBe(false);
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
      process.env.VELLUM_KEYCHAIN_BROKER_SOCKET = SOCKET_PATH;
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
      broker.setHandler(() => ({ ok: true, version: "1.0.0" }));
      await broker.start();

      const client = createBrokerClient();
      await client.ping();
      await client.ping();
      await client.ping();

      expect(connectionCount).toBe(1);
    });
  });
});
