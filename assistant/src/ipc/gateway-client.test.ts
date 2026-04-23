import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";

import {
  PersistentIpcClient,
  resetPersistentClient,
} from "./gateway-client.js";

// ---------------------------------------------------------------------------
// Mock gateway Unix socket server
// ---------------------------------------------------------------------------

let server: Server;
let socketPath: string;
let tmpDir: string;
let serverConnections: Socket[] = [];

/** Handler for incoming IPC requests. Override per-test as needed. */
let requestHandler: (
  req: { id: string; method: string; params?: Record<string, unknown> },
  sock: Socket,
) => void;

function defaultHandler(
  req: { id: string; method: string; params?: Record<string, unknown> },
  sock: Socket,
): void {
  sock.write(
    JSON.stringify({ id: req.id, result: { echo: req.method } }) + "\n",
  );
}

beforeAll(async () => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "ipc-test-")));
  socketPath = join(tmpDir, "persistent-ipc-test.sock");
  requestHandler = defaultHandler;

  await new Promise<void>((resolve) => {
    server = createServer((sock) => {
      serverConnections.push(sock);
      let buffer = "";
      sock.on("data", (chunk) => {
        buffer += chunk.toString();
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const req = JSON.parse(line);
            requestHandler(req, sock);
          } catch {
            // ignore malformed
          }
        }
      });
    });
    server.listen(socketPath, resolve);
  });
});

afterEach(() => {
  requestHandler = defaultHandler;
  resetPersistentClient();
});

afterAll(() => {
  for (const conn of serverConnections) {
    conn.destroy();
  }
  serverConnections = [];
  server.close();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PersistentIpcClient", () => {
  test("connects and sends correctly formatted JSON", async () => {
    const receivedRequests: unknown[] = [];
    requestHandler = (req, sock) => {
      receivedRequests.push(req);
      sock.write(JSON.stringify({ id: req.id, result: "ok" }) + "\n");
    };

    const client = new PersistentIpcClient(socketPath);
    try {
      const result = await client.call("test_method", { key: "value" });

      expect(result).toBe("ok");
      expect(receivedRequests).toHaveLength(1);

      const sent = receivedRequests[0] as {
        id: string;
        method: string;
        params: Record<string, unknown>;
      };
      expect(sent.id).toBeDefined();
      expect(sent.method).toBe("test_method");
      expect(sent.params).toEqual({ key: "value" });
    } finally {
      client.destroy();
    }
  });

  test("routes responses to the correct pending request by ID", async () => {
    // Delay responses so multiple requests are in-flight simultaneously.
    requestHandler = (req, sock) => {
      setTimeout(() => {
        sock.write(
          JSON.stringify({ id: req.id, result: `result-for-${req.method}` }) +
            "\n",
        );
      }, 10);
    };

    const client = new PersistentIpcClient(socketPath);
    try {
      const [r1, r2, r3] = await Promise.all([
        client.call("method_a"),
        client.call("method_b"),
        client.call("method_c"),
      ]);

      expect(r1).toBe("result-for-method_a");
      expect(r2).toBe("result-for-method_b");
      expect(r3).toBe("result-for-method_c");
    } finally {
      client.destroy();
    }
  });

  test("reconnects after socket close", async () => {
    let callCount = 0;
    requestHandler = (req, sock) => {
      callCount++;
      sock.write(
        JSON.stringify({ id: req.id, result: `call-${callCount}` }) + "\n",
      );
    };

    const client = new PersistentIpcClient(socketPath);
    try {
      // First call — establishes connection.
      const r1 = await client.call("first");
      expect(r1).toBe("call-1");

      // Force-close all server-side connections to simulate a disconnect.
      for (const conn of serverConnections) {
        conn.destroy();
      }
      serverConnections = [];

      // Allow the close event to propagate.
      await new Promise((r) => setTimeout(r, 50));

      // Second call — should reconnect automatically.
      const r2 = await client.call("second");
      expect(r2).toBe("call-2");
    } finally {
      client.destroy();
    }
  });

  test("rejects pending request on timeout", async () => {
    // Never respond, so the call should time out.
    requestHandler = () => {
      /* silence */
    };

    // Use a very short timeout so the test doesn't hang.
    const client = new PersistentIpcClient(socketPath, 100);
    try {
      await expect(client.call("slow_method")).rejects.toThrow(/timed out/);
    } finally {
      client.destroy();
    }
  });

  test("rejects pending requests when socket errors", async () => {
    requestHandler = (req, sock) => {
      // Simulate server-side error by destroying the connection.
      sock.destroy();
    };

    const client = new PersistentIpcClient(socketPath);
    try {
      await expect(client.call("will_error")).rejects.toThrow(/disconnected/);
    } finally {
      client.destroy();
    }
  });

  test("rejects with error message from server", async () => {
    requestHandler = (req, sock) => {
      sock.write(
        JSON.stringify({ id: req.id, error: "something went wrong" }) + "\n",
      );
    };

    const client = new PersistentIpcClient(socketPath);
    try {
      await expect(client.call("bad_call")).rejects.toThrow(
        "something went wrong",
      );
    } finally {
      client.destroy();
    }
  });

  test("destroy rejects all pending requests", async () => {
    requestHandler = () => {
      /* never respond */
    };

    const client = new PersistentIpcClient(socketPath, 10_000);
    const promise = client.call("pending_forever");
    // Give time for the request to be sent.
    await new Promise((r) => setTimeout(r, 20));
    client.destroy();

    await expect(promise).rejects.toThrow(/destroyed/);
  });

  test("connection failure rejects the call", async () => {
    const badPath = join(tmpDir, "nonexistent.sock");
    const client = new PersistentIpcClient(badPath);
    try {
      await expect(client.call("unreachable")).rejects.toThrow();
    } finally {
      client.destroy();
    }
  });
});
