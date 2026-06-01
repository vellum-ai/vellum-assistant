import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import {
  NGROK_API_PORT,
  pickPublicUrl,
  startNgrokTunnel,
  TUNNEL_POLL_INTERVAL_MS,
  TUNNEL_POLL_TIMEOUT_MS,
} from "../ngrok";

describe("pickPublicUrl", () => {
  test("prefers the https tunnel when both protos point at the right port", () => {
    const url = pickPublicUrl(
      {
        tunnels: [
          {
            public_url: "http://abc.ngrok-free.app",
            proto: "http",
            config: { addr: "http://localhost:3005" },
          },
          {
            public_url: "https://abc.ngrok-free.app",
            proto: "https",
            config: { addr: "http://localhost:3005" },
          },
        ],
      },
      3005,
    );
    expect(url).toBe("https://abc.ngrok-free.app");
  });

  test("falls back to http when no https tunnel is published", () => {
    const url = pickPublicUrl(
      {
        tunnels: [
          {
            public_url: "http://abc.ngrok-free.app",
            proto: "http",
            config: { addr: "127.0.0.1:3005" },
          },
        ],
      },
      3005,
    );
    expect(url).toBe("http://abc.ngrok-free.app");
  });

  test("matches addr forms: scheme+host+port, host+port, and bare :port", () => {
    for (const addr of ["http://localhost:3005", "127.0.0.1:3005", ":3005"]) {
      const url = pickPublicUrl(
        {
          tunnels: [
            {
              public_url: "https://abc.ngrok-free.app",
              proto: "https",
              config: { addr },
            },
          ],
        },
        3005,
      );
      expect(url).toBe("https://abc.ngrok-free.app");
    }
  });

  test("returns null when no tunnel targets the requested port", () => {
    const url = pickPublicUrl(
      {
        tunnels: [
          {
            public_url: "https://abc.ngrok-free.app",
            proto: "https",
            config: { addr: "http://localhost:9999" },
          },
        ],
      },
      3005,
    );
    expect(url).toBeNull();
  });

  test("returns null for missing / malformed payloads", () => {
    expect(pickPublicUrl(null, 3005)).toBeNull();
    expect(pickPublicUrl(undefined, 3005)).toBeNull();
    expect(pickPublicUrl({}, 3005)).toBeNull();
    expect(pickPublicUrl({ tunnels: "not-an-array" }, 3005)).toBeNull();
    expect(pickPublicUrl({ tunnels: [] }, 3005)).toBeNull();
    expect(pickPublicUrl({ tunnels: [{ proto: "https" }] }, 3005)).toBeNull();
  });
});

/**
 * Build a stand-in for `node:child_process`'s spawn return that emits
 * the events `startNgrokTunnel` listens for. Tests don't need stdout /
 * stderr streams to behave — the function attaches a noop "data"
 * listener purely to drain them, so the absence of emissions is fine.
 */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  killSignal: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = true;
    this.killSignal = signal;
    queueMicrotask(() => {
      this.exitCode = null;
      this.signalCode = signal;
      this.emit("exit", null, signal);
    });
    return true;
  }
}

function tunnelsPayload(port: number): { tunnels: unknown[] } {
  return {
    tunnels: [
      {
        public_url: "https://abc.ngrok-free.app",
        proto: "https",
        config: { addr: `http://localhost:${port}` },
      },
    ],
  };
}

function makeFetch(
  responses: Array<() => Promise<Response> | Response>,
): typeof fetch {
  let i = 0;
  return (async () => {
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return next();
  }) as unknown as typeof fetch;
}

describe("startNgrokTunnel", () => {
  test("returns the public URL once the agent publishes a tunnel", async () => {
    const child = new FakeChild();
    const spawnFn = (() =>
      child) as unknown as typeof import("node:child_process").spawn;

    // First poll: agent API not up yet (rejection). Second poll: tunnel
    // is published. Matches the real boot ordering — the agent binds
    // 4040 a tick before the tunnel record is live.
    const fetchFn = makeFetch([
      () => {
        throw new Error("ECONNREFUSED");
      },
      () => new Response(JSON.stringify(tunnelsPayload(3005)), { status: 200 }),
    ]);

    const tunnel = await startNgrokTunnel({
      port: 3005,
      pollIntervalMs: 5,
      pollTimeoutMs: 1_000,
      deps: { spawn: spawnFn, fetch: fetchFn },
    });
    expect(tunnel.publicUrl).toBe("https://abc.ngrok-free.app");

    await tunnel.stop();
    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe("SIGTERM");
  });

  test("throws a clear error when the ngrok agent exits before publishing", async () => {
    const child = new FakeChild();
    const spawnFn = (() =>
      child) as unknown as typeof import("node:child_process").spawn;

    // Crash the agent on the next tick — mirrors "missing authtoken"
    // and "port already tunnelled" failure modes.
    queueMicrotask(() => {
      child.exitCode = 1;
      child.emit("exit", 1, null);
    });

    const fetchFn = makeFetch([
      () => new Response("not ready", { status: 502 }),
    ]);

    await expect(
      startNgrokTunnel({
        port: 3005,
        pollIntervalMs: 5,
        pollTimeoutMs: 500,
        deps: { spawn: spawnFn, fetch: fetchFn },
      }),
    ).rejects.toThrow(/ngrok exited before publishing a tunnel/);
  });

  test("times out when the tunnel never comes up", async () => {
    const child = new FakeChild();
    const spawnFn = (() =>
      child) as unknown as typeof import("node:child_process").spawn;

    const fetchFn = makeFetch([
      () => new Response(JSON.stringify({ tunnels: [] }), { status: 200 }),
    ]);

    await expect(
      startNgrokTunnel({
        port: 3005,
        pollIntervalMs: 5,
        pollTimeoutMs: 50,
        deps: { spawn: spawnFn, fetch: fetchFn },
      }),
    ).rejects.toThrow(/did not come up within 50ms/);

    // Timeout path must kill the child so we don't leak a tunnel.
    expect(child.killed).toBe(true);
  });

  test("exports sensible defaults", () => {
    expect(NGROK_API_PORT).toBe(4040);
    expect(TUNNEL_POLL_INTERVAL_MS).toBe(250);
    expect(TUNNEL_POLL_TIMEOUT_MS).toBe(15_000);
  });
});
