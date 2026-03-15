/**
 * CES transport tests.
 *
 * Verifies:
 * 1. The managed entrypoint never opens a general localhost command API —
 *    the only command transport is via the accepted Unix socket stream.
 * 2. Health probes are served on a dedicated HTTP port, separate from
 *    the command transport.
 * 3. Local stdio transports are not accidentally inherited by shell
 *    subprocesses (the entrypoint does not open TCP listeners).
 * 4. The CES RPC server correctly performs handshake and dispatches methods.
 * 5. CES private data paths are correctly resolved for both modes.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";

import {
  CES_PROTOCOL_VERSION,
  type HandshakeAck,
  type RpcEnvelope,
} from "@vellumai/ces-contracts";

import { getCesDataRoot, getBootstrapSocketPath, getHealthPort } from "../paths.js";
import { CesRpcServer, type RpcHandlerRegistry } from "../server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a CesRpcServer wired to in-memory PassThrough streams for testing.
 */
function createTestServer(handlers: RpcHandlerRegistry = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const logs: string[] = [];

  const server = new CesRpcServer({
    input,
    output,
    handlers,
    logger: {
      log: (msg: string) => logs.push(`LOG: ${msg}`),
      warn: (msg: string) => logs.push(`WARN: ${msg}`),
      error: (msg: string) => logs.push(`ERROR: ${msg}`),
    },
  });

  /**
   * Collect all output lines from the server.
   */
  function collectOutputLines(): string[] {
    const data = output.read();
    if (!data) return [];
    const text = typeof data === "string" ? data : data.toString("utf-8");
    return text.split("\n").filter((l: string) => l.trim().length > 0);
  }

  /**
   * Send a JSON message to the server (newline-delimited).
   */
  function send(msg: unknown): void {
    input.write(JSON.stringify(msg) + "\n");
  }

  /**
   * Send a handshake request and read the response.
   */
  async function handshake(sessionId = "test-session"): Promise<HandshakeAck> {
    send({
      type: "handshake_request",
      protocolVersion: CES_PROTOCOL_VERSION,
      sessionId,
    });
    // Give the server a tick to process
    await new Promise((r) => setTimeout(r, 10));
    const lines = collectOutputLines();
    expect(lines.length).toBeGreaterThanOrEqual(1);
    return JSON.parse(lines[0]) as HandshakeAck;
  }

  /**
   * Send an RPC request and read the response.
   */
  async function rpc(
    method: string,
    payload: unknown,
    id = "1",
  ): Promise<RpcEnvelope> {
    send({
      type: "rpc",
      id,
      kind: "request",
      method,
      payload,
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 10));
    const lines = collectOutputLines();
    expect(lines.length).toBeGreaterThanOrEqual(1);
    return JSON.parse(lines[lines.length - 1]) as RpcEnvelope;
  }

  return { server, input, output, send, collectOutputLines, handshake, rpc, logs };
}

// ---------------------------------------------------------------------------
// 1. Managed entrypoint never opens a generic localhost command API
// ---------------------------------------------------------------------------

describe("managed entrypoint transport isolation", () => {
  test("managed-main.ts does not call Bun.serve for RPC (only health)", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "managed-main.ts"),
      "utf-8",
    );
    // Bun.serve calls in managed-main should only be in startHealthServer
    const bunServeMatches = src.match(/Bun\.serve\(/g);
    expect(bunServeMatches).not.toBeNull();
    // There should be exactly 1 Bun.serve call — for health probes only
    expect(bunServeMatches!.length).toBe(1);
  });

  test("managed-main.ts uses createNetServer for Unix socket, not Bun.serve", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "managed-main.ts"),
      "utf-8",
    );
    // Uses node:net createServer for the bootstrap socket
    expect(src).toMatch(/createNetServer/);
    // The net server never listens on a TCP port (only a socket path)
    expect(src).not.toMatch(/netServer\.listen\(\d+/);
  });

  test("managed-main.ts unlinks socket after accepting one connection", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "managed-main.ts"),
      "utf-8",
    );
    // Should unlink the socket path after connection
    expect(src).toMatch(/unlinkSync\(socketPath\)/);
    // Should close the net server after one connection
    expect(src).toMatch(/netServer\.close\(\)/);
  });
});

// ---------------------------------------------------------------------------
// 2. Health probes on dedicated port
// ---------------------------------------------------------------------------

describe("health probes", () => {
  test("managed-main.ts serves /healthz and /readyz on a separate port", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "managed-main.ts"),
      "utf-8",
    );
    expect(src).toMatch(/\/healthz/);
    expect(src).toMatch(/\/readyz/);
    // Health server uses Bun.serve on a dedicated port, not the socket
    expect(src).toMatch(/startHealthServer\(healthPort/);
  });

  test("getHealthPort defaults to 7841", () => {
    // Save and clear env
    const saved = process.env["CES_HEALTH_PORT"];
    delete process.env["CES_HEALTH_PORT"];
    try {
      expect(getHealthPort()).toBe(7841);
    } finally {
      if (saved !== undefined) process.env["CES_HEALTH_PORT"] = saved;
    }
  });

  test("getHealthPort respects CES_HEALTH_PORT env var", () => {
    const saved = process.env["CES_HEALTH_PORT"];
    process.env["CES_HEALTH_PORT"] = "9999";
    try {
      expect(getHealthPort()).toBe(9999);
    } finally {
      if (saved !== undefined) {
        process.env["CES_HEALTH_PORT"] = saved;
      } else {
        delete process.env["CES_HEALTH_PORT"];
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Local stdio transport not inherited by subprocesses
// ---------------------------------------------------------------------------

describe("local entrypoint transport isolation", () => {
  test("main.ts uses process.stdin/stdout, not TCP listeners", () => {
    const src = readFileSync(resolve(__dirname, "..", "main.ts"), "utf-8");
    // Uses stdin/stdout for transport
    expect(src).toMatch(/process\.stdin/);
    expect(src).toMatch(/process\.stdout/);
    // Does not open any TCP or Unix socket listener
    expect(src).not.toMatch(/Bun\.serve\(/);
    expect(src).not.toMatch(/createServer\(/);
    expect(src).not.toMatch(/\.listen\(/);
  });

  test("main.ts logs to stderr, not stdout (avoids polluting transport)", () => {
    const src = readFileSync(resolve(__dirname, "..", "main.ts"), "utf-8");
    // All log output goes to stderr
    expect(src).toMatch(/process\.stderr\.write/);
    // Should not use console.log (which writes to stdout)
    expect(src).not.toMatch(/console\.log\(/);
  });
});

// ---------------------------------------------------------------------------
// 4. CES RPC server handshake and dispatch
// ---------------------------------------------------------------------------

describe("CesRpcServer", () => {
  test("completes handshake with correct protocol version", async () => {
    const { server, handshake, input } = createTestServer();
    const servePromise = server.serve();

    const ack = await handshake();
    expect(ack.type).toBe("handshake_ack");
    expect(ack.accepted).toBe(true);
    expect(ack.protocolVersion).toBe(CES_PROTOCOL_VERSION);
    expect(ack.sessionId).toBe("test-session");
    expect(server.isHandshakeComplete).toBe(true);
    expect(server.currentSessionId).toBe("test-session");

    server.close();
    input.end();
  });

  test("rejects handshake with wrong protocol version", async () => {
    const { server, send, collectOutputLines, input } = createTestServer();
    const servePromise = server.serve();

    send({
      type: "handshake_request",
      protocolVersion: "99.99.99",
      sessionId: "bad-session",
    });

    await new Promise((r) => setTimeout(r, 10));
    const lines = collectOutputLines();
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const ack = JSON.parse(lines[0]) as HandshakeAck;
    expect(ack.accepted).toBe(false);
    expect(ack.reason).toMatch(/Unsupported protocol version/);
    expect(server.isHandshakeComplete).toBe(false);

    server.close();
    input.end();
  });

  test("rejects RPC before handshake", async () => {
    const { server, send, collectOutputLines, input } = createTestServer();
    const servePromise = server.serve();

    send({
      type: "rpc",
      id: "1",
      kind: "request",
      method: "list_grants",
      payload: {},
      timestamp: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 10));
    const lines = collectOutputLines();
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const resp = JSON.parse(lines[0]);
    expect(resp.payload.success).toBe(false);
    expect(resp.payload.error.code).toBe("HANDSHAKE_REQUIRED");

    server.close();
    input.end();
  });

  test("dispatches RPC to registered handler", async () => {
    const handlers: RpcHandlerRegistry = {
      list_grants: async (req: unknown) => {
        return { grants: [] };
      },
    };

    const { server, handshake, rpc, input } = createTestServer(handlers);
    const servePromise = server.serve();

    await handshake();

    const resp = await rpc("list_grants", {});
    expect(resp.kind).toBe("response");
    expect(resp.method).toBe("list_grants");
    expect((resp.payload as { grants: unknown[] }).grants).toEqual([]);

    server.close();
    input.end();
  });

  test("returns METHOD_NOT_FOUND for unknown methods", async () => {
    const { server, handshake, rpc, input } = createTestServer();
    const servePromise = server.serve();

    await handshake();

    const resp = await rpc("nonexistent_method", {});
    expect(resp.kind).toBe("response");
    expect((resp.payload as { success: boolean; error: { code: string } }).error.code).toBe(
      "METHOD_NOT_FOUND",
    );

    server.close();
    input.end();
  });

  test("returns HANDLER_ERROR when handler throws", async () => {
    const handlers: RpcHandlerRegistry = {
      fail_method: async () => {
        throw new Error("Intentional test failure");
      },
    };

    const { server, handshake, rpc, input } = createTestServer(handlers);
    const servePromise = server.serve();

    await handshake();

    const resp = await rpc("fail_method", {});
    expect(resp.kind).toBe("response");
    const payload = resp.payload as { success: boolean; error: { code: string; message: string } };
    expect(payload.error.code).toBe("HANDLER_ERROR");
    expect(payload.error.message).toMatch(/Intentional test failure/);

    server.close();
    input.end();
  });
});

// ---------------------------------------------------------------------------
// 5. CES private data paths
// ---------------------------------------------------------------------------

describe("CES data paths", () => {
  test("local mode data root includes 'protected/credential-executor'", () => {
    const root = getCesDataRoot("local");
    expect(root).toMatch(/protected[/\\]credential-executor$/);
  });

  test("managed mode data root defaults to /home/ces/.ces-data", () => {
    const savedDir = process.env["CES_DATA_DIR"];
    delete process.env["CES_DATA_DIR"];
    try {
      expect(getCesDataRoot("managed")).toBe("/home/ces/.ces-data");
    } finally {
      if (savedDir !== undefined) process.env["CES_DATA_DIR"] = savedDir;
    }
  });

  test("managed mode data root respects CES_DATA_DIR env var", () => {
    const savedDir = process.env["CES_DATA_DIR"];
    process.env["CES_DATA_DIR"] = "/custom/ces-data";
    try {
      expect(getCesDataRoot("managed")).toBe("/custom/ces-data");
    } finally {
      if (savedDir !== undefined) {
        process.env["CES_DATA_DIR"] = savedDir;
      } else {
        delete process.env["CES_DATA_DIR"];
      }
    }
  });

  test("local data root is under the Vellum root, not the workspace", () => {
    const root = getCesDataRoot("local");
    // Must be under .vellum/protected/, NOT .vellum/workspace/
    expect(root).toMatch(/\.vellum[/\\]protected[/\\]/);
    expect(root).not.toMatch(/workspace/);
  });

  test("getBootstrapSocketPath defaults to /run/ces/ces.sock", () => {
    const saved = process.env["CES_BOOTSTRAP_SOCKET"];
    delete process.env["CES_BOOTSTRAP_SOCKET"];
    try {
      expect(getBootstrapSocketPath()).toBe("/run/ces/ces.sock");
    } finally {
      if (saved !== undefined) process.env["CES_BOOTSTRAP_SOCKET"] = saved;
    }
  });

  test("getBootstrapSocketPath respects CES_BOOTSTRAP_SOCKET env var", () => {
    const saved = process.env["CES_BOOTSTRAP_SOCKET"];
    process.env["CES_BOOTSTRAP_SOCKET"] = "/tmp/test-ces.sock";
    try {
      expect(getBootstrapSocketPath()).toBe("/tmp/test-ces.sock");
    } finally {
      if (saved !== undefined) {
        process.env["CES_BOOTSTRAP_SOCKET"] = saved;
      } else {
        delete process.env["CES_BOOTSTRAP_SOCKET"];
      }
    }
  });
});
