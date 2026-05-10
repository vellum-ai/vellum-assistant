import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "./test-preload.js";

import { GatewayIpcServer, type IpcRoute } from "../ipc/server.js";

// Integration tests for GatewayIpcServer's watchdog wiring. The watchdog's
// own unit tests (race guards, timer error handling, etc.) live in
// `@vellumai/ipc-server-utils`. These tests verify that the gateway server
// correctly wires the watchdog into its own lifecycle and legacy-server
// bookkeeping.

// macOS caps Unix socket paths at sizeof(sun_path)-1 == 103 chars, so the
// shared test-preload temp dir is too long. Mint our own short path under
// the system tmpdir for this test.
const shortRoot = mkdtempSync(join(tmpdir(), "vmw-"));
const socketPath = join(shortRoot, "g.sock");

afterAll(() => {
  try {
    rmSync(shortRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

function connectClient(path: string): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const client: Socket = createConnection(path, () => resolve(client));
    client.on("error", reject);
  });
}

function sendRequest(
  client: Socket,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ id: string; result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const id = randomBytes(4).toString("hex");
    let buffer = "";

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        client.off("data", onData);
        try {
          resolve(JSON.parse(line));
        } catch (err) {
          reject(err);
        }
      }
    };

    client.on("data", onData);
    client.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

const echoRoute: IpcRoute = {
  method: "echo",
  handler: (params) => ({ echoed: params?.value ?? null }),
};

/**
 * Build a server with the test-owned short socket path. The constructor
 * resolves the path via env-var defaults that may not point at our temp
 * dir, so we override the private `socketPath` field directly — same
 * pattern used by `ipc-server-multi-client.test.ts`.
 *
 * Note: the watchdog is constructed in the GatewayIpcServer constructor
 * and captures the original (unmocked) socketPath via closure. Tests that
 * exercise the watchdog must therefore disable the timer-driven path and
 * use the public `rebindIfMissing()` entry point, which reads
 * `this.socketPath` lazily through the watchdog's `socketPath` capture —
 * which we also need to monkeypatch. See {@link buildServer}.
 */
function buildServer(opts: { watchdogIntervalMs: number }): GatewayIpcServer {
  const server = new GatewayIpcServer([echoRoute], {
    watchdogIntervalMs: opts.watchdogIntervalMs,
  });
  // The watchdog captures socketPath in its constructor, so override both
  // the public field (for start()/stop()) and the watchdog's private copy.
  (server as unknown as { socketPath: string }).socketPath = socketPath;
  const watchdog = (server as unknown as { watchdog: { socketPath: string } })
    .watchdog;
  watchdog.socketPath = socketPath;
  return server;
}

async function waitForListening(path: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  if (!existsSync(path)) {
    throw new Error(`server did not bind ${path} within ${timeoutMs}ms`);
  }
}

describe("GatewayIpcServer watchdog wiring", () => {
  let server: GatewayIpcServer | undefined;
  const sockets: Socket[] = [];

  beforeEach(() => {
    server = undefined;
  });

  afterEach(() => {
    for (const s of sockets) {
      if (!s.destroyed) s.destroy();
    }
    sockets.length = 0;

    if (server) {
      server.stop();
      server = undefined;
    }

    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // ignore
      }
    }
  });

  test("rebindIfMissing restores the listener and accepts new clients end-to-end", async () => {
    server = buildServer({ watchdogIntervalMs: 0 });
    server.start();
    await waitForListening(socketPath);

    // A baseline client confirms the initial listener is healthy.
    const baseline = await connectClient(socketPath);
    sockets.push(baseline);
    const baselineEcho = await sendRequest(baseline, "echo", { value: "pre" });
    expect(baselineEcho.result).toEqual({ echoed: "pre" });

    // Simulate the cleanup that wipes /run/* — unlink the socket file
    // while the listening fd is still alive in the kernel.
    unlinkSync(socketPath);
    expect(existsSync(socketPath)).toBe(false);

    const rebound = await server.rebindIfMissing();
    expect(rebound).toBe(true);
    expect(existsSync(socketPath)).toBe(true);

    // A new client can connect to the re-bound listener and exercise the
    // route table — proving onRebind correctly installed the new server
    // as the primary.
    const fresh = await connectClient(socketPath);
    sockets.push(fresh);
    const freshEcho = await sendRequest(fresh, "echo", { value: "post" });
    expect(freshEcho.result).toEqual({ echoed: "post" });

    // The pre-existing client survives the rebind because its connected
    // socket inode lives independently of the listener path.
    expect(baseline.destroyed).toBe(false);
  });

  test("stop() halts the watchdog so a later unlink does not resurrect the listener", async () => {
    server = buildServer({ watchdogIntervalMs: 10 });
    server.start();
    await waitForListening(socketPath);

    server.stop();
    expect(existsSync(socketPath)).toBe(false);

    // Even if something recreated and removed the path again, the watchdog
    // has been stopped and rebindIfMissing returns false because the
    // server reference was nulled.
    const rebound = await server.rebindIfMissing();
    expect(rebound).toBe(false);
    expect(existsSync(socketPath)).toBe(false);

    // Wait past several timer ticks to confirm no background rebind fires.
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(socketPath)).toBe(false);
  });
});
