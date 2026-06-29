/**
 * Tests for the local-mode CES Unix socket server.
 *
 * Covers:
 * - `getLocalSocketPath` resolution (env override + default).
 * - `socketToStreams` wrapping (no socket / listen required).
 * - End-to-end multi-accept over a real Unix socket: two concurrent
 *   connections each complete a handshake and an RPC. The socket `listen`
 *   requires a sandbox that permits binding, mirroring the existing
 *   managed-integration tests.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";

import {
  CES_PROTOCOL_VERSION,
  CesRpcMethod,
  type HandshakeAck,
  type ListGrantsResponse,
  type RpcEnvelope,
} from "@vellumai/service-contracts/credential-rpc";

import { getLocalSocketPath } from "../paths.js";
import {
  socketToStreams,
  startLocalSocketServer,
} from "../local-socket.js";
import { PersistentGrantStore } from "../grants/persistent-store.js";
import { createListGrantsHandler } from "../grants/rpc-handlers.js";
import type { RpcHandlerRegistry } from "../server.js";

// ---------------------------------------------------------------------------
// getLocalSocketPath
// ---------------------------------------------------------------------------

describe("getLocalSocketPath", () => {
  test("honors the CES_LOCAL_SOCKET override", () => {
    const prev = process.env["CES_LOCAL_SOCKET"];
    process.env["CES_LOCAL_SOCKET"] = "/tmp/custom/ces.sock";
    try {
      expect(getLocalSocketPath()).toBe("/tmp/custom/ces.sock");
    } finally {
      if (prev === undefined) delete process.env["CES_LOCAL_SOCKET"];
      else process.env["CES_LOCAL_SOCKET"] = prev;
    }
  });

  test("defaults to ces.sock under the local data root", () => {
    const prev = process.env["CES_LOCAL_SOCKET"];
    delete process.env["CES_LOCAL_SOCKET"];
    try {
      expect(getLocalSocketPath().endsWith("/ces.sock")).toBe(true);
    } finally {
      if (prev !== undefined) process.env["CES_LOCAL_SOCKET"] = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// socketToStreams (no real socket required)
// ---------------------------------------------------------------------------

/** Minimal Socket-like stub: emits data/end/error and records writes. */
class FakeSocket extends EventEmitter {
  writable = true;
  readonly writes: string[] = [];
  write(chunk: Buffer | string, cb?: (err?: Error | null) => void): boolean {
    this.writes.push(chunk.toString());
    cb?.(null);
    return true;
  }
}

describe("socketToStreams", () => {
  test("pushes socket data onto the readable and forwards writes to the socket", async () => {
    const socket = new FakeSocket();
    const { readable, writable } = socketToStreams(socket as unknown as Socket);

    const received: string[] = [];
    readable.on("data", (chunk: Buffer) => received.push(chunk.toString()));

    socket.emit("data", Buffer.from("hello\n"));
    writable.write("world\n");

    // Let the stream 'data' event flush.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received.join("")).toBe("hello\n");
    expect(socket.writes.join("")).toBe("world\n");
  });

  test("ends the readable when the socket ends", async () => {
    const socket = new FakeSocket();
    const { readable } = socketToStreams(socket as unknown as Socket);

    let ended = false;
    readable.on("end", () => {
      ended = true;
    });
    // A readable only emits 'end' once it's flowing and drained.
    readable.on("data", () => {});

    socket.emit("end");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ended).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end multi-accept over a real Unix socket
// ---------------------------------------------------------------------------

function buildGrantsHandlers(dataDir: string): RpcHandlerRegistry {
  const grantsDir = join(dataDir, "grants");
  mkdirSync(grantsDir, { recursive: true });
  const persistentGrantStore = new PersistentGrantStore(grantsDir);
  persistentGrantStore.init();

  const handlers: RpcHandlerRegistry = {};
  handlers[CesRpcMethod.ListGrants] = createListGrantsHandler({
    persistentGrantStore,
  }) as RpcHandlerRegistry[string];
  return handlers;
}

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
          setTimeout(tryConnect, baseDelayMs * Math.pow(2, Math.min(attempt, 6)));
        } else {
          reject(err);
        }
      });
    };
    tryConnect();
  });
}

function readMessages(
  sock: Socket,
  expectedCount: number,
  timeoutMs = 3000,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const messages: unknown[] = [];
    let buffer = "";
    const timer = setTimeout(() => {
      sock.removeAllListeners("data");
      resolve(messages);
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
          // skip malformed
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

function sendMessage(sock: Socket, msg: unknown): void {
  sock.write(JSON.stringify(msg) + "\n");
}

async function handshakeAndListGrants(
  socketPath: string,
  sessionId: string,
): Promise<{ ack: HandshakeAck; grants: ListGrantsResponse }> {
  const sock = await connectToSocket(socketPath);
  try {
    sendMessage(sock, {
      type: "handshake_request",
      protocolVersion: CES_PROTOCOL_VERSION,
      sessionId,
    });
    const [ackMsg] = await readMessages(sock, 1);
    const ack = ackMsg as HandshakeAck;

    sendMessage(sock, {
      type: "rpc",
      id: `${sessionId}-rpc-1`,
      kind: "request",
      method: CesRpcMethod.ListGrants,
      payload: {},
      timestamp: new Date().toISOString(),
    });
    const [rpcMsg] = await readMessages(sock, 1);
    const grants = (rpcMsg as RpcEnvelope & { type: "rpc" })
      .payload as ListGrantsResponse;

    return { ack, grants };
  } finally {
    sock.end();
  }
}

describe("local CES socket server (real Unix socket)", () => {
  let tmpDir: string;
  let controller: AbortController | undefined;

  afterEach(() => {
    controller?.abort();
    controller = undefined;
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  test("accepts multiple concurrent connections on one bound socket", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ces-local-socket-"));
    const socketPath = join(tmpDir, "ces.sock");
    const handlers = buildGrantsHandlers(tmpDir);

    controller = new AbortController();
    startLocalSocketServer({
      socketPath,
      handlers,
      signal: controller.signal,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });

    // Two siblings connect concurrently to the same bound socket — the socket
    // is NOT unlinked after the first accept (multi-accept).
    const [a, b] = await Promise.all([
      handshakeAndListGrants(socketPath, "sibling-a"),
      handshakeAndListGrants(socketPath, "sibling-b"),
    ]);

    expect(a.ack.accepted).toBe(true);
    expect(b.ack.accepted).toBe(true);
    expect(a.grants.grants).toEqual([]);
    expect(b.grants.grants).toEqual([]);
  });
});
