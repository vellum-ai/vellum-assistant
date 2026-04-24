/**
 * Tests for @vellumai/gateway-client
 *
 * Covers:
 * 1. Package independence — no imports from assistant/ or gateway/.
 * 2. IPC NDJSON framing and timeout behavior.
 * 3. HTTP delivery auth headers and error handling.
 * 4. HTTP trust-rules client auth and retry behavior.
 */

import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ipcCall, PersistentIpcClient } from "../ipc-client.js";
import { ChannelDeliveryError, deliverChannelReply } from "../http-delivery.js";
import { TrustRulesClient } from "../http-trust-rules.js";
import type { Logger } from "../types.js";

// ---------------------------------------------------------------------------
// Independence guard — package must not pull in assistant or gateway modules.
// ---------------------------------------------------------------------------

describe("package independence", () => {
  const sourceFiles = [
    "../index.ts",
    "../types.ts",
    "../http-delivery.ts",
    "../http-trust-rules.ts",
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

      const result = await ipcCall(socketPath, "unknown_method", undefined, log);
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
            conn.write(
              JSON.stringify({ id: req.id, result: "ok" }) + "\n",
            );
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

      await expect(callPromise).rejects.toThrow("PersistentIpcClient destroyed");
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
// ---------------------------------------------------------------------------

describe("http-delivery", () => {
  test("ChannelDeliveryError preserves statusCode and userMessage", () => {
    const err = new ChannelDeliveryError(403, "forbidden", "Access denied");
    expect(err.statusCode).toBe(403);
    expect(err.userMessage).toBe("Access denied");
    expect(err.name).toBe("ChannelDeliveryError");
    expect(err.message).toContain("403");
  });

  test("ChannelDeliveryError works without userMessage", () => {
    const err = new ChannelDeliveryError(500, "internal error");
    expect(err.statusCode).toBe(500);
    expect(err.userMessage).toBeUndefined();
  });

  test("deliverChannelReply sends POST with bearer token", async () => {
    let capturedHeaders: Headers | undefined;
    let capturedBody: string | undefined;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      capturedHeaders = req.headers;
      capturedBody = await req.text();
      return new Response(JSON.stringify({ ts: "1234.5678" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      const result = await deliverChannelReply(
        "https://gateway.example.com/callback",
        { chatId: "chat-123", text: "Hello" },
        "test-token-abc",
      );

      expect(result.ok).toBe(true);
      expect(result.ts).toBe("1234.5678");
      expect(capturedHeaders?.get("Authorization")).toBe("Bearer test-token-abc");
      expect(capturedHeaders?.get("Content-Type")).toBe("application/json");

      const body = JSON.parse(capturedBody!);
      expect(body.chatId).toBe("chat-123");
      expect(body.text).toBe("Hello");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("deliverChannelReply throws ChannelDeliveryError on non-OK response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({ userMessage: "Rate limited" }),
        { status: 429 },
      );
    };

    try {
      await expect(
        deliverChannelReply(
          "https://gateway.example.com/callback",
          { chatId: "chat-123", text: "Hello" },
        ),
      ).rejects.toThrow(ChannelDeliveryError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("deliverChannelReply extracts userMessage from JSON error response", async () => {
    const log = createTestLogger();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({ userMessage: "Channel disconnected" }),
        { status: 502 },
      );
    };

    try {
      let caught: ChannelDeliveryError | undefined;
      try {
        await deliverChannelReply(
          "https://gateway.example.com/callback",
          { chatId: "chat-123", text: "Hello" },
          undefined,
          log,
        );
      } catch (err) {
        caught = err as ChannelDeliveryError;
      }

      expect(caught).toBeDefined();
      expect(caught!.userMessage).toBe("Channel disconnected");
      expect(
        log.messages.some(
          (m) => m.msg === "Gateway returned actionable error for user",
        ),
      ).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("deliverChannelReply omits Authorization when no bearer token", async () => {
    let capturedHeaders: Headers | undefined;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = new Request(input, init).headers;
      return new Response("{}", { status: 200 });
    };

    try {
      await deliverChannelReply(
        "https://gateway.example.com/callback",
        { chatId: "chat-123", text: "Hello" },
      );
      expect(capturedHeaders?.has("Authorization")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP trust-rules: auth and error behavior
// ---------------------------------------------------------------------------

describe("http-trust-rules", () => {
  test("TrustRulesClient sends Authorization header from mintToken", async () => {
    let capturedAuth: string | null = null;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      capturedAuth = new Request(input, init).headers.get("Authorization");
      return new Response(
        JSON.stringify({
          rules: [
            {
              id: "rule-1",
              tool: "host_bash",
              pattern: "ls *",
              decision: "allow",
              scope: "/",
              priority: 0,
              createdAt: new Date().toISOString(),
            },
          ],
        }),
        { status: 200 },
      );
    };

    const client = new TrustRulesClient({
      gatewayBaseUrl: "http://localhost:7820",
      mintToken: () => "edge-relay-token-xyz",
    });

    try {
      await client.getAllRules();
      expect(capturedAuth).toBe("Bearer edge-relay-token-xyz");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("TrustRulesClient throws on non-OK response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response("Unauthorized", { status: 401 });
    };

    const client = new TrustRulesClient({
      gatewayBaseUrl: "http://localhost:7820",
      mintToken: () => "bad-token",
    });

    try {
      await expect(client.getAllRules()).rejects.toThrow(
        "Trust rule request failed (401)",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("TrustRulesClient throws on network error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };

    const client = new TrustRulesClient({
      gatewayBaseUrl: "http://localhost:7820",
      mintToken: () => "token",
    });

    try {
      await expect(client.getAllRules()).rejects.toThrow("ECONNREFUSED");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("TrustRulesClient.addRule sends correct path and body", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | undefined;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      capturedUrl = req.url;
      capturedBody = (await req.json()) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          rule: {
            id: "new-rule",
            tool: "host_bash",
            pattern: "npm *",
            decision: "allow",
            scope: "/workspace",
            priority: 10,
            createdAt: new Date().toISOString(),
          },
        }),
        { status: 200 },
      );
    };

    const client = new TrustRulesClient({
      gatewayBaseUrl: "http://localhost:7820",
      mintToken: () => "token",
    });

    try {
      const rule = await client.addRule({
        tool: "host_bash",
        pattern: "npm *",
        scope: "/workspace",
        decision: "allow",
        priority: 10,
      });

      expect(capturedUrl).toBe("http://localhost:7820/v1/trust-rules");
      expect(capturedBody).toEqual({
        tool: "host_bash",
        pattern: "npm *",
        scope: "/workspace",
        decision: "allow",
        priority: 10,
      });
      expect(rule.id).toBe("new-rule");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("TrustRulesClient.removeRule URL-encodes the rule ID", async () => {
    let capturedUrl = "";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = new Request(input, init).url;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    const client = new TrustRulesClient({
      gatewayBaseUrl: "http://localhost:7820",
      mintToken: () => "token",
    });

    try {
      const result = await client.removeRule("rule/with/slashes");
      expect(result).toBe(true);
      expect(capturedUrl).toContain("rule%2Fwith%2Fslashes");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("TrustRulesClient.findMatchingRule returns null when no match", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ rule: null }), { status: 200 });
    };

    const client = new TrustRulesClient({
      gatewayBaseUrl: "http://localhost:7820",
      mintToken: () => "token",
    });

    try {
      const rule = await client.findMatchingRule("host_bash", ["ls"], "/");
      expect(rule).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
