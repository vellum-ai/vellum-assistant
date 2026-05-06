import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "./test-preload.js";

import { GatewayIpcServer, type IpcRoute } from "../ipc/server.js";

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
 */
function buildServer(opts: { watchdogIntervalMs: number }): GatewayIpcServer {
  const server = new GatewayIpcServer([echoRoute], {
    watchdogIntervalMs: opts.watchdogIntervalMs,
  });
  (server as unknown as { socketPath: string }).socketPath = socketPath;
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

describe("GatewayIpcServer socket-file watchdog", () => {
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

  test("rebindIfMissing is a no-op when the socket path exists", async () => {
    server = buildServer({ watchdogIntervalMs: 0 });
    server.start();
    await waitForListening(socketPath);
    expect(existsSync(socketPath)).toBe(true);

    const rebound = await server.rebindIfMissing();
    expect(rebound).toBe(false);
    expect(existsSync(socketPath)).toBe(true);
  });

  test("rebindIfMissing is a no-op when the server has not been started", async () => {
    server = buildServer({ watchdogIntervalMs: 0 });
    const rebound = await server.rebindIfMissing();
    expect(rebound).toBe(false);
  });

  test("rebindIfMissing recreates the path entry after an external unlink", async () => {
    server = buildServer({ watchdogIntervalMs: 0 });
    server.start();
    await waitForListening(socketPath);
    expect(existsSync(socketPath)).toBe(true);

    unlinkSync(socketPath);
    expect(existsSync(socketPath)).toBe(false);

    const rebound = await server.rebindIfMissing();
    expect(rebound).toBe(true);
    expect(existsSync(socketPath)).toBe(true);
  });

  test("a fresh client can connect and call a method after re-bind", async () => {
    server = buildServer({ watchdogIntervalMs: 0 });
    server.start();
    await waitForListening(socketPath);

    unlinkSync(socketPath);
    await server.rebindIfMissing();
    expect(existsSync(socketPath)).toBe(true);

    const client = await connectClient(socketPath);
    sockets.push(client);

    const response = await sendRequest(client, "echo", { value: "after-rebind" });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ echoed: "after-rebind" });
  });

  test("a client connected before the unlink can still send and receive", async () => {
    server = buildServer({ watchdogIntervalMs: 0 });
    server.start();
    await waitForListening(socketPath);

    const persistent = await connectClient(socketPath);
    sockets.push(persistent);

    // Round-trip once before the disruption to confirm the connection is good.
    const before = await sendRequest(persistent, "echo", { value: "before" });
    expect(before.result).toEqual({ echoed: "before" });

    unlinkSync(socketPath);
    await server.rebindIfMissing();

    // The kernel keeps the existing connection alive even though the
    // listener path was replaced; in-flight RPCs continue to work because
    // they ride the same already-connected socket.
    const after = await sendRequest(persistent, "echo", { value: "after" });
    expect(after.error).toBeUndefined();
    expect(after.result).toEqual({ echoed: "after" });
  });

  test("the periodic watchdog re-binds without manual intervention", async () => {
    server = buildServer({ watchdogIntervalMs: 25 });
    server.start();
    await waitForListening(socketPath);

    unlinkSync(socketPath);
    expect(existsSync(socketPath)).toBe(false);

    // Wait up to 1s for the watchdog to notice and re-bind.
    const deadline = Date.now() + 1000;
    while (!existsSync(socketPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(existsSync(socketPath)).toBe(true);

    // And it should be a healthy listener — verify with a fresh client.
    const client = await connectClient(socketPath);
    sockets.push(client);
    const response = await sendRequest(client, "echo", { value: "watchdog" });
    expect(response.result).toEqual({ echoed: "watchdog" });
  });

  test("stop() cancels the watchdog timer and cleans up the path", async () => {
    server = buildServer({ watchdogIntervalMs: 25 });
    server.start();
    await waitForListening(socketPath);

    server.stop();
    server = undefined;

    // After stop, the path is cleaned up. If the timer were still alive it
    // would log "missing on disk" warnings indefinitely; verify no fresh
    // socket file appears after some idle time.
    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(socketPath)).toBe(false);
  });

  test("rebindIfMissing aborts cleanly when shutdown happens mid-listen", async () => {
    server = buildServer({ watchdogIntervalMs: 0 });
    server.start();
    await waitForListening(socketPath);

    // Trigger the path-missing condition so the rebind actually engages.
    unlinkSync(socketPath);

    // Async functions run synchronously up to the first await — this
    // returns to us with newServer.listen() in flight.
    const inFlight = server.rebindIfMissing();

    // Simulate stop() racing the rebind: just clear the live server
    // pointer. We can't call full stop() here because we want to observe
    // exactly the post-listen race-guard branch and not a server already
    // closed by the time listen resolves; clearing the field is the same
    // signal stop() raises (see stop()'s `this.server = null`).
    (server as unknown as { server: null }).server = null;

    const result = await inFlight;
    expect(result).toBe(false);

    // The discarded newServer should have been closed AND its path
    // unlinked, so we don't leak a stale listener after "shutdown".
    expect(existsSync(socketPath)).toBe(false);

    // The race guard must NOT have resurrected the listener.
    expect(
      (server as unknown as { server: unknown }).server,
    ).toBeNull();

    // Manual cleanup — afterEach will try to call stop() on a server
    // that's already in a partially-broken state, which is fine because
    // stop() is null-safe on this.server.
  });

  test("watchdog timer catches synchronous rebind errors so unhandled rejections don't escape", async () => {
    server = buildServer({ watchdogIntervalMs: 25 });
    server.start();
    await waitForListening(socketPath);

    const unhandledRejections: unknown[] = [];
    const onUnhandled = (err: unknown) => {
      unhandledRejections.push(err);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      // Force rebindIfMissing to throw synchronously by replacing
      // ensureSocketDir on the live instance — simulates mkdirSync
      // failing (e.g. EACCES on a read-only fs).
      let throwCount = 0;
      (
        server as unknown as { ensureSocketDir: () => void }
      ).ensureSocketDir = () => {
        throwCount++;
        throw new Error("simulated mkdirSync failure");
      };

      // Trigger the path-missing condition so each tick engages the
      // throwing code path.
      unlinkSync(socketPath);

      // Wait for several watchdog ticks (~5 ticks at 25ms = 125ms).
      await new Promise((r) => setTimeout(r, 200));

      // The timer must have fired multiple times — proving the
      // rejection didn't kill it.
      expect(throwCount).toBeGreaterThanOrEqual(2);

      // No unhandled rejections must have escaped the catch()
      // wrapper in start()'s setInterval.
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
