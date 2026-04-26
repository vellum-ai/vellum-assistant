/**
 * Tests for @vellumai/gateway-client
 *
 * Covers:
 * 1. Package independence — no imports from assistant/ or gateway/.
 * 2. IPC NDJSON framing and timeout behavior.
 * 3. HTTP delivery auth headers and error handling.
 */

import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ipcCall, PersistentIpcClient } from "../ipc-client.js";
import { ChannelDeliveryError, deliverChannelReply } from "../http-delivery.js";
import type { Logger } from "../types.js";

// ---------------------------------------------------------------------------
// Independence guard — package must not pull in assistant or gateway modules.
// ---------------------------------------------------------------------------

describe("package independence", () => {
  const sourceFiles = [
    "../index.ts",
    "../types.ts",
    "../http-delivery.ts",
    "../ipc-client.ts",
    "../trust-rules.ts",
  ];

  for (const file of sourceFiles) {
    test(`${file} does not import from assistant/ or gateway/`, () => {
      const src = require("node:fs").readFileSync(
        require("node:path").resolve(__dirname, file),
        "utf-8",
      );
      expect(src).not.toMatch(/from\s+['"].*assistant\//);
      expect(src).not.toMatch(/from\s+['"].*gateway\//);
      expect(src).not.toMatch(/require\(['"].*assistant\//);
      expect(src).not.toMatch(/require\(['"].*gateway\//);
    });
  }
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a no-op logger that collects messages for assertions. */
function createTestLogger(): Logger & {
  messages: Array<{ level: string; msg: string }>;
} {
  const messages: Array<{ level: string; msg: string }> = [];
  return {
    messages,
    debug(_obj: Record<string, unknown>, msg: string) {
      messages.push({ level: "debug", msg });
    },
    info(_obj: Record<string, unknown>, msg: string) {
      messages.push({ level: "info", msg });
    },
    warn(_obj: Record<string, unknown>, msg: string) {
      messages.push({ level: "warn", msg });
    },
    error(_obj: Record<string, unknown>, msg: string) {
      messages.push({ level: "error", msg });
    },
  };
}

/** Create a temporary Unix socket path for tests. */
function tmpSocketPath(): string {
  return join(tmpdir(), `gw-client-test-${randomUUID()}.sock`);
}

// ---------------------------------------------------------------------------
// IPC: NDJSON framing
// ---------------------------------------------------------------------------

describe("ipc-client", () => {
  describe("ipcCall — one-shot", () => {
    let server: Server;
    let socketPath: string;

    beforeEach(() => {
      socketPath = tmpSocketPath();
    });

    afterEach(() => {
      server?.close();
      try {
        unlinkSync(socketPath);
      } catch {
        // Already cleaned up
      }
    });

    test("sends NDJSON request and parses NDJSON response", async () => {
      server = createServer((conn) => {
        let buf = "";
        conn.on("data", (chunk) => {
          buf += chunk.toString();
          const idx = buf.indexOf("\n");
          if (idx !== -1) {
            const line = buf.slice(0, idx);
            const req = JSON.parse(line);
            const resp = JSON.stringify({
              id: req.id,
              result: { flags: { browser: true } },
            });
            conn.write(resp + "\n");
          }
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(socketPath, () => resolve());
      });

      const result = await ipcCall(socketPath, "get_feature_flags");
      expect(result).toEqual({ flags: { browser: true } });
    });

    test("returns undefined when server sends error response", async () => {
      const log = createTestLogger();
      server = createServer((conn) => {
        let buf = "";
        conn.on("data", (chunk) => {
          buf += chunk.toString();
          const idx = buf.indexOf("\n");
          if (idx !== -1) {
            const req = JSON.parse(buf.slice(0, idx));
            conn.write(
              JSON.stringify({ id: req.id, error: "method not found" }) + "\n",
            );
          }
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(socketPath, () => resolve());
      });

      const result = await ipcCall(
        socketPath,
        "unknown_method",
        undefined,
        log,
      );
      expect(result).toBeUndefined();
      expect(
        log.messages.some((m) => m.msg === "IPC call returned error"),
      ).toBe(true);
    });

    test("returns undefined when socket does not exist", async () => {
      const log = createTestLogger();
      const result = await ipcCall(
        "/tmp/nonexistent-socket.sock",
        "test_method",
        undefined,
        log,
      );
      expect(result).toBeUndefined();
    });

    test("forwards params in the request", async () => {
      let receivedParams: Record<string, unknown> | undefined;
      server = createServer((conn) => {
        let buf = "";
        conn.on("data", (chunk) => {
          buf += chunk.toString();
          const idx = buf.indexOf("\n");
          if (idx !== -1) {
            const req = JSON.parse(buf.slice(0, idx));
            receivedParams = req.params;
            conn.write(JSON.stringify({ id: req.id, result: "ok" }) + "\n");
          }
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(socketPath, () => resolve());
      });

      await ipcCall(socketPath, "test", { key: "value" });
      expect(receivedParams).toEqual({ key: "value" });
    });

    test("handles fragmented NDJSON across multiple data chunks", async () => {
      server = createServer((conn) => {
        let buf = "";
        conn.on("data", (chunk) => {
          buf += chunk.toString();
          const idx = buf.indexOf("\n");
          if (idx !== -1) {
            const req = JSON.parse(buf.slice(0, idx));
            const resp = JSON.stringify({ id: req.id, result: 42 });
            // Send the response in two separate chunks
            const mid = Math.floor(resp.length / 2);
            conn.write(resp.slice(0, mid));
            setTimeout(() => {
              conn.write(resp.slice(mid) + "\n");
            }, 10);
          }
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(socketPath, () => resolve());
      });

      const result = await ipcCall(socketPath, "fragmented");
      expect(result).toBe(42);
    });
  });

  describe("PersistentIpcClient", () => {
    let server: Server;
    let socketPath: string;

    beforeEach(() => {
      socketPath = tmpSocketPath();
    });

    afterEach(() => {
      server?.close();
      try {
        unlinkSync(socketPath);
      } catch {
        // Already cleaned up
      }
    });

    test("multiplexes concurrent calls over a single connection", async () => {
      server = createServer((conn) => {
        let buf = "";
        conn.on("data", (chunk) => {
          buf += chunk.toString();
          let idx: number;
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            const req = JSON.parse(line);
            // Echo the method as the result
            conn.write(
              JSON.stringify({ id: req.id, result: req.method }) + "\n",
            );
          }
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(socketPath, () => resolve());
      });

      const client = new PersistentIpcClient(socketPath);
      try {
        const [r1, r2, r3] = await Promise.all([
          client.call("method_a"),
          client.call("method_b"),
          client.call("method_c"),
        ]);
        expect(r1).toBe("method_a");
        expect(r2).toBe("method_b");
        expect(r3).toBe("method_c");
      } finally {
        client.destroy();
      }
    });

    test("rejects pending calls on destroy", async () => {
      server = createServer(() => {
        // Server accepts but never responds
      });

      await new Promise<void>((resolve) => {
        server.listen(socketPath, () => resolve());
      });

      const client = new PersistentIpcClient(socketPath, 30_000);
      const callPromise = client.call("hanging_method");
      // Give the connection time to establish
      await new Promise((r) => setTimeout(r, 50));
      client.destroy();

      await expect(callPromise).rejects.toThrow(
        "PersistentIpcClient destroyed",
      );
    });

    test("rejects on server error response", async () => {
      server = createServer((conn) => {
        let buf = "";
        conn.on("data", (chunk) => {
          buf += chunk.toString();
          const idx = buf.indexOf("\n");
          if (idx !== -1) {
            const req = JSON.parse(buf.slice(0, idx));
            conn.write(
              JSON.stringify({ id: req.id, error: "something broke" }) + "\n",
            );
          }
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(socketPath, () => resolve());
      });

      const client = new PersistentIpcClient(socketPath);
      try {
        await expect(client.call("broken")).rejects.toThrow("something broke");
      } finally {
        client.destroy();
      }
    });

    test("times out when server does not respond", async () => {
      server = createServer(() => {
        // Accepts connections but never responds
      });

      await new Promise<void>((resolve) => {
        server.listen(socketPath, () => resolve());
      });

      const client = new PersistentIpcClient(socketPath, 100);
      try {
        await expect(client.call("slow_method")).rejects.toThrow("timed out");
      } finally {
        client.destroy();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// HTTP delivery: auth headers and error handling
