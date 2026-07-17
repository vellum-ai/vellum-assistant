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
} from "@vellumai/service-contracts/credential-rpc";

import {
  getCesDataRoot,
  getBootstrapSocketPath,
  getHealthPort,
} from "../paths.js";
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

  return {
    server,
    input,
    output,
    send,
    collectOutputLines,
    handshake,
    rpc,
    logs,
  };
}

// ---------------------------------------------------------------------------
// 1. Managed entrypoint never opens a generic localhost command API
// ---------------------------------------------------------------------------

describe("managed entrypoint transport isolation", () => {
  test("main.ts uses Bun.serve only for health probes (managed mode)", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "main.ts"),
      "utf-8",
    );
    // Bun.serve is used for the health server in managed mode
    const bunServeMatches = src.match(/Bun\.serve\(/g);
    expect(bunServeMatches).not.toBeNull();
    // There should be exactly 1 Bun.serve call — for health probes only
    expect(bunServeMatches!.length).toBe(1);
  });

  test("main.ts uses createNetServer for Unix socket transport", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "main.ts"),
      "utf-8",
    );
    // Uses node:net createServer for the socket transport (both modes)
    expect(src).toMatch(/createNetServer/);
    // The net server never listens on a TCP port (only a socket path)
    expect(src).not.toMatch(/netServer\.listen\(\d+/);
  });
});

// ---------------------------------------------------------------------------
// 2. Health probes on dedicated port
// ---------------------------------------------------------------------------

describe("health probes", () => {
  test("main.ts serves /healthz and /readyz in managed mode", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "main.ts"),
      "utf-8",
    );
    expect(src).toMatch(/\/healthz/);
    expect(src).toMatch(/\/readyz/);
    // Health server uses Bun.serve on a dedicated port, not the socket
    expect(src).toMatch(/startHealthServer\(\s*healthPort/);
  });

  test("getHealthPort defaults to 8090", () => {
    // Save and clear env
    const saved = process.env["CES_HEALTH_PORT"];
    delete process.env["CES_HEALTH_PORT"];
    try {
      expect(getHealthPort()).toBe(8090);
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
// 3. Local socket transport not inherited by subprocesses
// ---------------------------------------------------------------------------

describe("local entrypoint transport isolation", () => {
  test("main.ts serves over a Unix socket, never stdio or a TCP listener", () => {
    const src = readFileSync(resolve(__dirname, "..", "main.ts"), "utf-8");
    // Socket transport only — no stdio-child transport.
    expect(src).not.toMatch(/process\.stdin/);
    expect(src).not.toMatch(/process\.stdout/);
    // Bun.serve is only used inside the managed-mode health server block
    // (startHealthServer), never for RPC transport. The RPC transport uses
    // node:net createServer listening on a Unix socket path.
    const bunServeMatches = src.match(/Bun\.serve\(/g);
    expect(bunServeMatches).not.toBeNull();
    expect(bunServeMatches!.length).toBe(1);
    // The Bun.serve call must be inside the startHealthServer function, which
    // is only invoked in managed mode.
    expect(src).toMatch(/function startHealthServer/);
    // Never listens on a numeric TCP port for RPC transport.
    expect(src).not.toMatch(/\.listen\(\d+/);
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
    const _servePromise = server.serve();

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
    const _servePromise = server.serve();

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
    const _servePromise = server.serve();

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
      list_grants: async (_req: unknown) => {
        return { grants: [] };
      },
    };

    const { server, handshake, rpc, input } = createTestServer(handlers);
    const _servePromise = server.serve();

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
    const _servePromise = server.serve();

    await handshake();

    const resp = await rpc("nonexistent_method", {});
    expect(resp.kind).toBe("response");
    expect(
      (resp.payload as { success: boolean; error: { code: string } }).error
        .code,
    ).toBe("METHOD_NOT_FOUND");

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
    const _servePromise = server.serve();

    await handshake();

    const resp = await rpc("fail_method", {});
    expect(resp.kind).toBe("response");
    const payload = resp.payload as {
      success: boolean;
      error: { code: string; message: string };
    };
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

  test("managed mode data root defaults to /ces-data", () => {
    const savedDir = process.env["CES_DATA_DIR"];
    delete process.env["CES_DATA_DIR"];
    try {
      expect(getCesDataRoot("managed")).toBe("/ces-data");
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

  test("getBootstrapSocketPath defaults to /run/ces-bootstrap/ces.sock", () => {
    const saved = process.env["CES_BOOTSTRAP_SOCKET"];
    delete process.env["CES_BOOTSTRAP_SOCKET"];
    try {
      expect(getBootstrapSocketPath()).toBe("/run/ces-bootstrap/ces.sock");
    } finally {
      if (saved !== undefined) process.env["CES_BOOTSTRAP_SOCKET"] = saved;
    }
  });

  test("getBootstrapSocketPath respects CES_BOOTSTRAP_SOCKET env var", () => {
    const savedSocket = process.env["CES_BOOTSTRAP_SOCKET"];
    const savedDir = process.env["CES_BOOTSTRAP_SOCKET_DIR"];
    // CES_BOOTSTRAP_SOCKET_DIR takes precedence; clear it so the
    // CES_BOOTSTRAP_SOCKET fallback is actually exercised.
    delete process.env["CES_BOOTSTRAP_SOCKET_DIR"];
    process.env["CES_BOOTSTRAP_SOCKET"] = "/tmp/test-ces.sock";
    try {
      expect(getBootstrapSocketPath()).toBe("/tmp/test-ces.sock");
    } finally {
      if (savedSocket !== undefined) {
        process.env["CES_BOOTSTRAP_SOCKET"] = savedSocket;
      } else {
        delete process.env["CES_BOOTSTRAP_SOCKET"];
      }
      if (savedDir !== undefined) {
        process.env["CES_BOOTSTRAP_SOCKET_DIR"] = savedDir;
      } else {
        delete process.env["CES_BOOTSTRAP_SOCKET_DIR"];
      }
    }
  });
});
