/**
 * Local CES sibling test (real entrypoint subprocess).
 *
 * Spawns the actual `main.ts` entrypoint with **stdin closed** — the way the
 * CLI launches the sibling — and verifies that CES:
 *
 *   1. binds its Unix socket and serves RPC despite having no stdio parent
 *      (lifecycle anchored to SIGTERM, not stdin), and
 *   2. survives a client disconnecting, and
 *   3. shuts down on SIGTERM.
 *
 * Local mode has no TCP health server, so this runs without binding a TCP port.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createConnection, type Socket } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  CES_PROTOCOL_VERSION,
  CesRpcMethod,
  type HandshakeAck,
  type RpcEnvelope,
  type ListCredentialsResponse,
} from "@vellumai/service-contracts/credential-rpc";

import type { Subprocess } from "bun";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForSocket(
  socketPath: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) return;
    await delay(50);
  }
  throw new Error(`Standalone CES socket did not appear within ${timeoutMs}ms`);
}

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

/** Read one newline-delimited JSON message from the socket. */
function readOne<T>(sock: Socket, timeoutMs = 5_000): Promise<T> {
  return new Promise((resolveMsg, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      sock.removeAllListeners("data");
      reject(new Error("Timed out waiting for a message"));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      clearTimeout(timer);
      sock.removeListener("data", onData);
      try {
        resolveMsg(JSON.parse(buffer.slice(0, idx).trim()) as T);
      } catch (err) {
        reject(err as Error);
      }
    };
    sock.on("data", onData);
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function handshake(
  sock: Socket,
  sessionId: string,
): Promise<HandshakeAck> {
  sock.write(
    JSON.stringify({
      type: "handshake_request",
      protocolVersion: CES_PROTOCOL_VERSION,
      sessionId,
    }) + "\n",
  );
  return readOne<HandshakeAck>(sock);
}

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

describe("local CES standalone sibling (real entrypoint)", () => {
  test("serves over a socket with no stdio parent, survives disconnect, exits on SIGTERM", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ces-standalone-"));
    const socketPath = join(tmpDir, "ces.sock");
    const securityDir = join(tmpDir, "protected");
    const workspaceDir = join(tmpDir, "workspace");
    mkdirSync(securityDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });

    const localMain = resolve(__dirname, "..", "main.ts");

    // stdin closed is how the CLI launches the sibling — CES serves over a
    // Unix socket, not stdio.
    proc = Bun.spawn({
      cmd: [process.execPath, localMain],
      env: {
        ...process.env,
        CES_LOCAL_SOCKET: socketPath,
        CREDENTIAL_SECURITY_DIR: securityDir,
        VELLUM_WORKSPACE_DIR: workspaceDir,
        CES_SERVICE_TOKEN: "",
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });

    await waitForSocket(socketPath);
    expect(proc.killed).toBe(false);

    // First client: handshake + a real RPC.
    const first = await connectToSocket(socketPath);
    const ack1 = await handshake(first, "sibling-1");
    expect(ack1.accepted).toBe(true);

    first.write(
      JSON.stringify({
        type: "rpc",
        id: "rpc-1",
        kind: "request",
        method: CesRpcMethod.ListCredentials,
        payload: {},
        timestamp: new Date().toISOString(),
      }) + "\n",
    );
    const rpcResp = await readOne<RpcEnvelope & { type: "rpc" }>(first);
    expect((rpcResp.payload as ListCredentialsResponse).accounts).toEqual([]);

    // Disconnect — CES must stay up.
    first.destroy();
    await delay(200);
    expect(proc.killed).toBe(false);

    // Reconnect proves it survived.
    const second = await connectToSocket(socketPath);
    const ack2 = await handshake(second, "sibling-2");
    expect(ack2.accepted).toBe(true);
    second.destroy();

    // SIGTERM shuts it down.
    proc.kill("SIGTERM");
    const exited = await Promise.race([
      proc.exited.then(() => true),
      delay(5_000).then(() => false),
    ]);
    expect(exited).toBe(true);
  }, 30_000);
});
