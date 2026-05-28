/**
 * Managed CES reconnection test (real entrypoint subprocess).
 *
 * Spawns the actual `managed-main.ts` entrypoint and verifies that the CES
 * sidecar survives the assistant disconnecting and accepts a reconnection,
 * rather than shutting down when the RPC stream ends.
 *
 * This guards the core invariant that CES runs independently of whether the
 * assistant is actively connected: the assistant container can crash and be
 * restarted (Kubernetes restarts containers, not the whole pod), and the
 * restarted assistant must be able to reconnect to a still-running CES.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createConnection, createServer, type Socket } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  CES_PROTOCOL_VERSION,
  type HandshakeAck,
} from "@vellumai/service-contracts/credential-rpc";

import type { Subprocess } from "bun";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sleep for the given number of milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Pick a currently-free TCP port by binding to port 0 and reading it back. */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
    srv.on("error", reject);
  });
}

/** Poll the health endpoint until it responds OK or the deadline passes. */
async function waitForHealth(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (resp.ok) return;
    } catch {
      // not up yet
    }
    await delay(100);
  }
  throw new Error(`CES health endpoint did not come up within ${timeoutMs}ms`);
}

/** Read the `rpcConnected` field from /readyz. */
async function readyzRpcConnected(port: number): Promise<boolean> {
  const resp = await fetch(`http://127.0.0.1:${port}/readyz`);
  const body = (await resp.json()) as { rpcConnected?: boolean };
  return body.rpcConnected === true;
}

/** Wait until the socket path exists (CES has bound the bootstrap socket). */
async function waitForSocket(socketPath: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) return;
    await delay(50);
  }
  throw new Error(`Bootstrap socket did not appear within ${timeoutMs}ms`);
}

/** Connect to the bootstrap socket, retrying past the listen/connect race. */
function connectToSocket(
  socketPath: string,
  { maxRetries = 40, baseDelayMs = 25 } = {},
): Promise<Socket> {
  return new Promise((resolveConn, reject) => {
    let attempt = 0;
    const tryConnect = () => {
      const sock = createConnection(socketPath, () => {
        sock.removeAllListeners("error");
        resolveConn(sock);
      });
      sock.on("error", (err: NodeJS.ErrnoException) => {
        sock.destroy();
        attempt++;
        if (
          attempt < maxRetries &&
          (err.code === "ENOENT" || err.code === "ECONNREFUSED")
        ) {
          setTimeout(tryConnect, baseDelayMs);
        } else {
          reject(err);
        }
      });
    };
    tryConnect();
  });
}

/** Send a handshake and resolve the resulting ack. */
function handshake(sock: Socket, sessionId: string): Promise<HandshakeAck> {
  return new Promise((resolveAck, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      sock.removeAllListeners("data");
      reject(new Error("Timed out waiting for handshake ack"));
    }, 5_000);

    sock.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx).trim();
      clearTimeout(timer);
      sock.removeAllListeners("data");
      try {
        resolveAck(JSON.parse(line) as HandshakeAck);
      } catch (err) {
        reject(err as Error);
      }
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    sock.write(
      JSON.stringify({
        type: "handshake_request",
        protocolVersion: CES_PROTOCOL_VERSION,
        sessionId,
      }) + "\n",
    );
  });
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

let tmpDir: string | undefined;
let proc: Subprocess | undefined;

afterEach(async () => {
  if (proc) {
    proc.kill("SIGTERM");
    await Promise.race([proc.exited, delay(3_000)]);
    proc = undefined;
  }
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ok */
    }
    tmpDir = undefined;
  }
});

describe("managed CES reconnection (real entrypoint)", () => {
  test("survives an assistant disconnect and accepts a reconnection", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ces-reconnect-"));
    const dataDir = join(tmpDir, "ces-data");
    const socketDir = join(tmpDir, "bootstrap");
    const socketPath = join(socketDir, "ces.sock");
    const assistantDataMount = join(tmpDir, "assistant-data-ro");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(socketDir, { recursive: true });
    mkdirSync(join(assistantDataMount, ".vellum"), { recursive: true });

    const healthPort = await pickFreePort();
    const managedMain = resolve(__dirname, "..", "managed-main.ts");

    proc = Bun.spawn({
      cmd: [process.execPath, managedMain],
      env: {
        ...process.env,
        CES_MODE: "managed",
        CES_DATA_DIR: dataDir,
        CES_BOOTSTRAP_SOCKET: socketPath,
        CES_HEALTH_PORT: String(healthPort),
        CES_ASSISTANT_DATA_MOUNT: assistantDataMount,
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    // Sidecar comes up and binds the bootstrap socket.
    await waitForHealth(healthPort);
    await waitForSocket(socketPath);
    expect(await readyzRpcConnected(healthPort)).toBe(false);

    // First assistant session connects and completes a handshake.
    const first = await connectToSocket(socketPath);
    const ack1 = await handshake(first, "session-1");
    expect(ack1.accepted).toBe(true);

    // Give /readyz a moment to flip, then confirm CES sees the connection.
    await delay(200);
    expect(await readyzRpcConnected(healthPort)).toBe(true);

    // Simulate the assistant pod crashing: drop the connection hard.
    first.destroy();

    // CES must NOT exit. It should stay healthy, flip rpcConnected back to
    // false, and re-bind the bootstrap socket to await a reconnection.
    await waitForSocket(socketPath);
    expect(proc.killed).toBe(false);
    const resp = await fetch(`http://127.0.0.1:${healthPort}/healthz`);
    expect(resp.ok).toBe(true);

    // Wait for the new session's rpcConnected to clear before reconnecting.
    const cleared = await (async () => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (!(await readyzRpcConnected(healthPort))) return true;
        await delay(100);
      }
      return false;
    })();
    expect(cleared).toBe(true);

    // The restarted assistant reconnects and handshakes successfully.
    const second = await connectToSocket(socketPath);
    const ack2 = await handshake(second, "session-2");
    expect(ack2.accepted).toBe(true);
    expect(ack2.sessionId).toBe("session-2");

    await delay(200);
    expect(await readyzRpcConnected(healthPort)).toBe(true);

    second.destroy();
  }, 30_000);
});
