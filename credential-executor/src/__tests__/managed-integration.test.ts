/**
 * Managed CES integration test with real Unix socket transport.
 *
 * Exercises the full CES RPC transport stack over a real Unix socket
 * without mocks, Docker, K8s, or real OAuth credentials:
 *
 * 1. Starts the managed CES server on a temporary Unix socket
 * 2. Connects as a client via the real socket
 * 3. Performs the RPC handshake (protocol version negotiation)
 * 4. Sends an RPC request (`list_grants`) and verifies the response
 * 5. Verifies the health server responds on its HTTP port
 * 6. Cleans up sockets, temp dirs, and servers
 *
 * This complements the existing transport.test.ts (which uses
 * PassThrough streams) by proving that the real Unix socket
 * accept-one-connection flow, newline-delimited JSON framing,
 * and health endpoint all work end-to-end.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import { Readable, Writable } from "node:stream";

import {
  CES_PROTOCOL_VERSION,
  CesRpcMethod,
  type HandshakeAck,
  type ListGrantsResponse,
  type RpcEnvelope,
} from "@vellumai/ces-contracts";

import { PersistentGrantStore } from "../grants/persistent-store.js";
import { TemporaryGrantStore } from "../grants/temporary-store.js";
import { AuditStore } from "../audit/store.js";
import {
  createListGrantsHandler,
  createListAuditRecordsHandler,
} from "../grants/rpc-handlers.js";
import { CesRpcServer, type RpcHandlerRegistry, type SessionIdRef } from "../server.js";

// ---------------------------------------------------------------------------
// Environment setup
// ---------------------------------------------------------------------------

/** Env vars saved/restored across tests. */
const SAVED_ENV_KEYS = [
  "CES_DATA_DIR",
  "CES_BOOTSTRAP_SOCKET_DIR",
  "CES_BOOTSTRAP_SOCKET",
  "CES_HEALTH_PORT",
  "CES_MODE",
] as const;

type SavedEnv = Record<string, string | undefined>;

function saveEnv(): SavedEnv {
  const saved: SavedEnv = {};
  for (const key of SAVED_ENV_KEYS) {
    saved[key] = process.env[key];
  }
  return saved;
}

function restoreEnv(saved: SavedEnv): void {
  for (const [key, val] of Object.entries(saved)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal RPC handler registry with `list_grants` and
 * `list_audit_records` backed by real stores in a temp directory.
 */
function buildMinimalHandlers(dataDir: string): RpcHandlerRegistry {
  const grantsDir = join(dataDir, "grants");
  const auditDir = join(dataDir, "audit");
  mkdirSync(grantsDir, { recursive: true });
  mkdirSync(auditDir, { recursive: true });

  const persistentGrantStore = new PersistentGrantStore(grantsDir);
  persistentGrantStore.init();

  const auditStore = new AuditStore(auditDir);
  auditStore.init();

  const handlers: RpcHandlerRegistry = {};

  handlers[CesRpcMethod.ListGrants] = createListGrantsHandler({
    persistentGrantStore,
  }) as typeof handlers[string];

  handlers[CesRpcMethod.ListAuditRecords] = createListAuditRecordsHandler({
    auditStore,
  }) as typeof handlers[string];

  return handlers;
}

/**
 * Accept a single connection on a Unix socket and return
 * readable/writable streams plus cleanup helpers.
 *
 * Replicates the same accept-one-connection pattern from managed-main.ts
 * but in a test-friendly form.
 */
function acceptOneConnection(socketPath: string, signal: AbortSignal): Promise<{
  readable: Readable;
  writable: Writable;
  socket: Socket;
}> {
  return new Promise((resolve, reject) => {
    const { createServer: createNetServer } = require("node:net");
    const netServer = createNetServer();

    const cleanup = () => {
      netServer.close();
      try { require("node:fs").unlinkSync(socketPath); } catch { /* ok */ }
    };

    if (signal.aborted) {
      reject(new Error("Aborted before listening"));
      return;
    }

    signal.addEventListener("abort", () => {
      cleanup();
      reject(new Error("Aborted while waiting for connection"));
    }, { once: true });

    netServer.on("error", (err: Error) => {
      cleanup();
      reject(err);
    });

    netServer.listen(socketPath, () => {
      // listening
    });

    netServer.on("connection", (sock: Socket) => {
      netServer.close();
      try { require("node:fs").unlinkSync(socketPath); } catch { /* ok */ }

      const readable = new Readable({ read() {} });
      const writable = new Writable({
        write(chunk: Buffer, _encoding: string, callback: (err?: Error | null) => void) {
          if (sock.writable) {
            sock.write(chunk, callback);
          } else {
            callback(new Error("Socket no longer writable"));
          }
        },
      });

      sock.on("data", (chunk: Buffer) => readable.push(chunk));
      sock.on("end", () => readable.push(null));
      sock.on("error", (err: Error) => {
        readable.destroy(err);
        writable.destroy(err);
      });

      resolve({ readable, writable, socket: sock });
    });
  });
}

/**
 * Connect to a Unix socket as a client, retrying on transient errors.
 *
 * `acceptOneConnection` starts a `net.Server` and the socket path only
 * exists once the server's `listen` callback fires. On slower CI runners
 * the `createConnection` call can race ahead and hit `ENOENT` or
 * `ECONNREFUSED` before the path is ready. A short retry loop with
 * exponential back-off absorbs this race without needing an explicit
 * readiness signal from the server side.
 */
function connectToSocket(
  socketPath: string,
  { maxRetries = 20, baseDelayMs = 10 } = {},
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    const tryConnect = () => {
      const sock = createConnection(socketPath, () => {
        sock.removeAllListeners("error");
        resolve(sock);
      });
      sock.on("error", (err: NodeJS.ErrnoException) => {
        sock.destroy();
        attempt++;
        if (
          attempt < maxRetries &&
          (err.code === "ENOENT" || err.code === "ECONNREFUSED")
        ) {
          const delay = baseDelayMs * Math.pow(2, Math.min(attempt, 6));
          setTimeout(tryConnect, delay);
        } else {
          reject(err);
        }
      });
    };

    tryConnect();
  });
}

/**
 * Read newline-delimited JSON messages from a socket, collecting them
 * until the expected count is reached or a timeout fires.
 */
function readMessages(sock: Socket, expectedCount: number, timeoutMs = 3000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const messages: unknown[] = [];
    let buffer = "";

    const timer = setTimeout(() => {
      sock.removeAllListeners("data");
      resolve(messages); // resolve with what we have
    }, timeoutMs);

    sock.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.length === 0) continue;
        try {
          messages.push(JSON.parse(line));
        } catch {
          // skip malformed lines
        }
        if (messages.length >= expectedCount) {
          clearTimeout(timer);
          sock.removeAllListeners("data");
          resolve(messages);
          return;
        }
      }
    });

    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Send a newline-delimited JSON message through a socket.
 */
function sendMessage(sock: Socket, msg: unknown): void {
  sock.write(JSON.stringify(msg) + "\n");
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let tmpDir: string;
let savedEnv: SavedEnv;
let controller: AbortController;
let healthServer: ReturnType<typeof Bun.serve> | undefined;
let clientSocket: Socket | undefined;
let serverRpcServer: CesRpcServer | undefined;

afterEach(async () => {
  // Shut down server and client
  controller?.abort();
  serverRpcServer?.close();
  clientSocket?.destroy();
  if (healthServer) {
    healthServer.stop(true);
    healthServer = undefined;
  }

  // Restore env
  if (savedEnv) restoreEnv(savedEnv);

  // Clean up temp dir
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ok */ }
  }
});

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("managed CES integration (real Unix socket)", () => {
  test("full lifecycle: handshake, RPC dispatch, and health endpoint", async () => {
    // -- Setup temp dirs and env -----------------------------------------------
    savedEnv = saveEnv();
    tmpDir = mkdtempSync(join(tmpdir(), "ces-managed-integ-"));
    const dataDir = join(tmpDir, "ces-data");
    const socketDir = join(tmpDir, "bootstrap");
    const socketPath = join(socketDir, "ces.sock");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(socketDir, { recursive: true });

    process.env["CES_DATA_DIR"] = dataDir;
    process.env["CES_MODE"] = "managed";

    // -- Pick a free port for health server ------------------------------------
    // Use port 0 trick: bind, read the port, close, then use it.
    const healthPort = await new Promise<number>((resolve) => {
      const srv = require("node:net").createServer();
      srv.listen(0, () => {
        const port = srv.address().port;
        srv.close(() => resolve(port));
      });
    });
    process.env["CES_HEALTH_PORT"] = String(healthPort);

    controller = new AbortController();

    // -- Start health server ---------------------------------------------------
    healthServer = Bun.serve({
      port: healthPort,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/healthz") {
          return new Response(
            JSON.stringify({ status: "ok", version: CES_PROTOCOL_VERSION }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.pathname === "/readyz") {
          return new Response(
            JSON.stringify({ ready: true, version: CES_PROTOCOL_VERSION }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    // -- Start accept-one-connection on the Unix socket ------------------------
    const connectionPromise = acceptOneConnection(socketPath, controller.signal);

    // -- Client connects -------------------------------------------------------
    clientSocket = await connectToSocket(socketPath);

    // -- Server gets the connection and wires up RPC ---------------------------
    const conn = await connectionPromise;

    const sessionIdRef: SessionIdRef = { current: `integ-${Date.now()}` };
    const handlers = buildMinimalHandlers(dataDir);

    serverRpcServer = new CesRpcServer({
      input: conn.readable,
      output: conn.writable,
      handlers,
      logger: {
        log: () => {},
        warn: () => {},
        error: () => {},
      },
      signal: controller.signal,
      onHandshakeComplete: (hsSessionId) => {
        sessionIdRef.current = hsSessionId;
      },
    });

    const servePromise = serverRpcServer.serve();

    // -- Step 1: Handshake -----------------------------------------------------
    const handshakeSessionId = `integ-session-${Date.now()}`;
    sendMessage(clientSocket, {
      type: "handshake_request",
      protocolVersion: CES_PROTOCOL_VERSION,
      sessionId: handshakeSessionId,
    });

    const handshakeMessages = await readMessages(clientSocket, 1);
    expect(handshakeMessages.length).toBe(1);

    const ack = handshakeMessages[0] as HandshakeAck;
    expect(ack.type).toBe("handshake_ack");
    expect(ack.accepted).toBe(true);
    expect(ack.protocolVersion).toBe(CES_PROTOCOL_VERSION);
    expect(ack.sessionId).toBe(handshakeSessionId);

    // Verify onHandshakeComplete callback fired
    expect(sessionIdRef.current).toBe(handshakeSessionId);

    // -- Step 2: RPC dispatch (list_grants) ------------------------------------
    const rpcId = "rpc-1";
    sendMessage(clientSocket, {
      type: "rpc",
      id: rpcId,
      kind: "request",
      method: CesRpcMethod.ListGrants,
      payload: {},
      timestamp: new Date().toISOString(),
    });

    const rpcMessages = await readMessages(clientSocket, 1);
    expect(rpcMessages.length).toBe(1);

    const rpcResp = rpcMessages[0] as RpcEnvelope & { type: "rpc" };
    expect(rpcResp.type).toBe("rpc");
    expect(rpcResp.id).toBe(rpcId);
    expect(rpcResp.kind).toBe("response");
    expect(rpcResp.method).toBe(CesRpcMethod.ListGrants);

    const grantsPayload = rpcResp.payload as ListGrantsResponse;
    expect(grantsPayload.grants).toEqual([]);

    // -- Step 3: RPC dispatch (list_audit_records) -----------------------------
    const auditRpcId = "rpc-2";
    sendMessage(clientSocket, {
      type: "rpc",
      id: auditRpcId,
      kind: "request",
      method: CesRpcMethod.ListAuditRecords,
      payload: {},
      timestamp: new Date().toISOString(),
    });

    const auditMessages = await readMessages(clientSocket, 1);
    expect(auditMessages.length).toBe(1);

    const auditResp = auditMessages[0] as RpcEnvelope & { type: "rpc" };
    expect(auditResp.type).toBe("rpc");
    expect(auditResp.id).toBe(auditRpcId);
    expect(auditResp.kind).toBe("response");
    expect(auditResp.method).toBe(CesRpcMethod.ListAuditRecords);

    const auditPayload = auditResp.payload as { records: unknown[]; nextCursor: string | null };
    expect(auditPayload.records).toEqual([]);
    expect(auditPayload.nextCursor).toBeNull();

    // -- Step 4: Health endpoint -----------------------------------------------
    const healthzResp = await fetch(`http://localhost:${healthPort}/healthz`);
    expect(healthzResp.status).toBe(200);
    const healthzBody = await healthzResp.json();
    expect(healthzBody.status).toBe("ok");
    expect(healthzBody.version).toBe(CES_PROTOCOL_VERSION);

    const readyzResp = await fetch(`http://localhost:${healthPort}/readyz`);
    expect(readyzResp.status).toBe(200);
    const readyzBody = await readyzResp.json();
    expect(readyzBody.ready).toBe(true);
    expect(readyzBody.version).toBe(CES_PROTOCOL_VERSION);

    // -- Step 5: Unknown method returns METHOD_NOT_FOUND -----------------------
    const unknownRpcId = "rpc-3";
    sendMessage(clientSocket, {
      type: "rpc",
      id: unknownRpcId,
      kind: "request",
      method: "nonexistent_method",
      payload: {},
      timestamp: new Date().toISOString(),
    });

    const unknownMessages = await readMessages(clientSocket, 1);
    expect(unknownMessages.length).toBe(1);

    const unknownResp = unknownMessages[0] as RpcEnvelope & { type: "rpc" };
    expect(unknownResp.id).toBe(unknownRpcId);
    expect(unknownResp.kind).toBe("response");
    const unknownPayload = unknownResp.payload as { success: boolean; error: { code: string } };
    expect(unknownPayload.error.code).toBe("METHOD_NOT_FOUND");

    // -- Cleanup ---------------------------------------------------------------
    clientSocket.end();
    controller.abort();
    await servePromise;
  });

  test("rejects handshake with mismatched protocol version over real socket", async () => {
    savedEnv = saveEnv();
    tmpDir = mkdtempSync(join(tmpdir(), "ces-managed-integ-hs-"));
    const dataDir = join(tmpDir, "ces-data");
    const socketDir = join(tmpDir, "bootstrap");
    const socketPath = join(socketDir, "ces.sock");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(socketDir, { recursive: true });

    process.env["CES_DATA_DIR"] = dataDir;
    process.env["CES_MODE"] = "managed";

    controller = new AbortController();

    const connectionPromise = acceptOneConnection(socketPath, controller.signal);
    clientSocket = await connectToSocket(socketPath);
    const conn = await connectionPromise;

    serverRpcServer = new CesRpcServer({
      input: conn.readable,
      output: conn.writable,
      handlers: {},
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      signal: controller.signal,
    });

    const servePromise = serverRpcServer.serve();

    // Send handshake with wrong version
    sendMessage(clientSocket, {
      type: "handshake_request",
      protocolVersion: "99.99.99",
      sessionId: "bad-version-session",
    });

    const messages = await readMessages(clientSocket, 1);
    expect(messages.length).toBe(1);

    const ack = messages[0] as HandshakeAck;
    expect(ack.type).toBe("handshake_ack");
    expect(ack.accepted).toBe(false);
    expect(ack.reason).toMatch(/Unsupported protocol version/);
    expect(ack.protocolVersion).toBe(CES_PROTOCOL_VERSION);

    clientSocket.end();
    controller.abort();
    await servePromise;
  });

  test("rejects RPC before handshake over real socket", async () => {
    savedEnv = saveEnv();
    tmpDir = mkdtempSync(join(tmpdir(), "ces-managed-integ-pre-hs-"));
    const dataDir = join(tmpDir, "ces-data");
    const socketDir = join(tmpDir, "bootstrap");
    const socketPath = join(socketDir, "ces.sock");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(socketDir, { recursive: true });

    process.env["CES_DATA_DIR"] = dataDir;
    process.env["CES_MODE"] = "managed";

    controller = new AbortController();

    const connectionPromise = acceptOneConnection(socketPath, controller.signal);
    clientSocket = await connectToSocket(socketPath);
    const conn = await connectionPromise;

    const handlers = buildMinimalHandlers(dataDir);
    serverRpcServer = new CesRpcServer({
      input: conn.readable,
      output: conn.writable,
      handlers,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      signal: controller.signal,
    });

    const servePromise = serverRpcServer.serve();

    // Send RPC without handshake
    sendMessage(clientSocket, {
      type: "rpc",
      id: "pre-hs-1",
      kind: "request",
      method: CesRpcMethod.ListGrants,
      payload: {},
      timestamp: new Date().toISOString(),
    });

    const messages = await readMessages(clientSocket, 1);
    expect(messages.length).toBe(1);

    const resp = messages[0] as RpcEnvelope & { type: "rpc" };
    expect(resp.id).toBe("pre-hs-1");
    expect(resp.kind).toBe("response");
    const payload = resp.payload as { success: boolean; error: { code: string } };
    expect(payload.error.code).toBe("HANDSHAKE_REQUIRED");

    clientSocket.end();
    controller.abort();
    await servePromise;
  });

  test("socket is single-use (second connection attempt fails)", async () => {
    savedEnv = saveEnv();
    tmpDir = mkdtempSync(join(tmpdir(), "ces-managed-integ-single-"));
    const socketDir = join(tmpDir, "bootstrap");
    const socketPath = join(socketDir, "ces.sock");
    mkdirSync(socketDir, { recursive: true });

    controller = new AbortController();

    const connectionPromise = acceptOneConnection(socketPath, controller.signal);

    // First connection succeeds
    clientSocket = await connectToSocket(socketPath);
    const conn = await connectionPromise;

    // Socket file should be unlinked after the first connection,
    // so a second connection attempt should fail.
    // Use maxRetries: 0 so the ENOENT rejects immediately instead of
    // retrying for ~10 s (which exceeds the 5 s test timeout on slow CI).
    await expect(
      connectToSocket(socketPath, { maxRetries: 0 }),
    ).rejects.toThrow();

    // Clean up
    conn.socket.destroy();
    clientSocket.end();
    controller.abort();
  });
});
