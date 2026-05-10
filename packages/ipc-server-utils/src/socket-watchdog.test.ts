import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SocketWatchdog, type SocketWatchdogLogger } from "./socket-watchdog.js";

// macOS caps Unix-socket paths at sizeof(sun_path)-1 == 103 bytes, so the
// shared test-preload temp dir is too long. Mint a short path under tmpdir
// for these tests.
const shortRoot = mkdtempSync(join(tmpdir(), "vmw-"));
const socketPath = join(shortRoot, "g.sock");

afterAll(() => {
  try {
    rmSync(shortRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

interface TestHarness {
  watchdog: SocketWatchdog;
  /** Mutated by tests to simulate stop()/restart. */
  serverRef: { current: Server | null };
  /** Servers handed to onRebind, captured for assertions + cleanup. */
  rebinds: Array<{ newServer: Server; oldServer: Server }>;
  log: SocketWatchdogLogger;
  loggedErrors: Array<{ obj: object; msg?: string }>;
  /** Tracks every server the harness factory produced, for cleanup. */
  spawnedServers: Server[];
}

interface BuildOptions {
  intervalMs?: number;
  createServerOverride?: () => Server;
  /** Override `getServer` to simulate races. */
  getServerOverride?: () => Server | null;
}

function buildHarness(opts: BuildOptions): TestHarness {
  const serverRef: { current: Server | null } = { current: null };
  const rebinds: Array<{ newServer: Server; oldServer: Server }> = [];
  const loggedErrors: Array<{ obj: object; msg?: string }> = [];
  const spawnedServers: Server[] = [];

  const log: SocketWatchdogLogger = {
    info: () => {},
    warn: () => {},
    error: (obj, msg) => {
      loggedErrors.push({ obj, msg });
    },
  };

  const defaultFactory = () => {
    const s = createServer();
    s.on("error", () => {
      /* tests don't care; suppress */
    });
    spawnedServers.push(s);
    return s;
  };

  const watchdog = new SocketWatchdog({
    socketPath,
    intervalMs: opts.intervalMs ?? 0,
    getServer: opts.getServerOverride ?? (() => serverRef.current),
    createServer: opts.createServerOverride ?? defaultFactory,
    onRebind: (newServer, oldServer) => {
      rebinds.push({ newServer, oldServer });
      serverRef.current = newServer;
      // Mirror gateway behavior: close old server gracefully so its
      // accept-loop drains. Close errors are not the watchdog's concern.
      oldServer.close(() => {
        /* drained */
      });
    },
    log,
  });

  return { watchdog, serverRef, rebinds, log, loggedErrors, spawnedServers };
}

/**
 * Spin up a real listening server and install it into the harness. Returns
 * once the kernel reports the socket file present on disk.
 */
async function startInitialServer(harness: TestHarness): Promise<Server> {
  const server = createServer();
  server.on("error", () => {
    /* ignore */
  });
  harness.spawnedServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => resolve());
    server.listen(socketPath);
  });
  harness.serverRef.current = server;
  return server;
}

function connectClient(path: string): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const client: Socket = createConnection(path, () => resolve(client));
    client.on("error", reject);
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

describe("SocketWatchdog", () => {
  let harness: TestHarness | undefined;
  const sockets: Socket[] = [];

  beforeEach(() => {
    harness = undefined;
    // Defensive: clean up any leftover socket file from a previous test
    // whose afterEach didn't fully drain.
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        /* ignore */
      }
    }
  });

  afterEach(async () => {
    for (const s of sockets) {
      if (!s.destroyed) s.destroy();
    }
    sockets.length = 0;

    if (harness) {
      harness.watchdog.stop();
      // Close every server the harness produced, regardless of how the
      // test left things. Closing an already-closed server is a no-op.
      for (const s of harness.spawnedServers) {
        try {
          await closeServer(s);
        } catch {
          /* already closed */
        }
      }
      harness = undefined;
    }

    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        /* ignore */
      }
    }
  });

  test("rebindIfMissing is a no-op when the socket path exists", async () => {
    harness = buildHarness({});
    await startInitialServer(harness);

    const rebound = await harness.watchdog.rebindIfMissing();
    expect(rebound).toBe(false);
    expect(harness.rebinds).toHaveLength(0);
    expect(existsSync(socketPath)).toBe(true);
  });

  test("rebindIfMissing is a no-op when getServer returns null", async () => {
    harness = buildHarness({});
    // serverRef.current stays null.
    const rebound = await harness.watchdog.rebindIfMissing();
    expect(rebound).toBe(false);
    expect(harness.rebinds).toHaveLength(0);
  });

  test("rebindIfMissing recreates the listener when the path is gone", async () => {
    harness = buildHarness({});
    const initial = await startInitialServer(harness);
    expect(existsSync(socketPath)).toBe(true);

    // Simulate the cleanup that wipes /run/* — unlink the path while the
    // listener fd is still alive in the kernel.
    unlinkSync(socketPath);
    expect(existsSync(socketPath)).toBe(false);

    const rebound = await harness.watchdog.rebindIfMissing();
    expect(rebound).toBe(true);
    expect(existsSync(socketPath)).toBe(true);
    expect(harness.rebinds).toHaveLength(1);
    expect(harness.rebinds[0]!.oldServer).toBe(initial);
    expect(harness.serverRef.current).toBe(harness.rebinds[0]!.newServer);

    // A fresh client can connect to the re-bound listener.
    const client = await connectClient(socketPath);
    sockets.push(client);
    expect(client.destroyed).toBe(false);
  });

  test("connected clients survive a rebind", async () => {
    harness = buildHarness({});
    await startInitialServer(harness);

    const survivor = await connectClient(socketPath);
    sockets.push(survivor);
    expect(survivor.destroyed).toBe(false);

    unlinkSync(socketPath);
    const rebound = await harness.watchdog.rebindIfMissing();
    expect(rebound).toBe(true);

    // Give the close-callback a moment to settle without churning the EL.
    await new Promise((r) => setTimeout(r, 10));
    expect(survivor.destroyed).toBe(false);
  });

  test("rebindIfMissing aborts when getServer changes mid-listen (shutdown race)", async () => {
    // Drive the race deterministically by mutating what getServer returns
    // between its first call (precondition check) and its second call
    // (post-listen race guard).
    const initial = createServer();
    initial.on("error", () => {});
    await new Promise<void>((r) => {
      initial.once("listening", () => r());
      initial.listen(socketPath);
    });

    let getServerCalls = 0;
    const rebinds: Array<{ newServer: Server; oldServer: Server }> = [];
    const spawnedNewServers: Server[] = [];

    const watchdog = new SocketWatchdog({
      socketPath,
      intervalMs: 0,
      getServer: () => {
        getServerCalls++;
        // First call: precondition — initialServer is still around.
        // Subsequent calls (race guard): null, simulating stop().
        return getServerCalls === 1 ? initial : null;
      },
      createServer: () => {
        const s = createServer();
        s.on("error", () => {});
        spawnedNewServers.push(s);
        return s;
      },
      onRebind: (n, o) => {
        rebinds.push({ newServer: n, oldServer: o });
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    unlinkSync(socketPath);
    expect(existsSync(socketPath)).toBe(false);

    const rebound = await watchdog.rebindIfMissing();
    expect(rebound).toBe(false);
    expect(rebinds).toHaveLength(0);
    // The race guard should have unlinked the path the discarded server
    // recreated, so a future start() doesn't see a phantom listener.
    expect(existsSync(socketPath)).toBe(false);
    // getServer was called at least twice — once for precondition, once
    // for the race guard.
    expect(getServerCalls).toBeGreaterThanOrEqual(2);

    // Cleanup: initial is still listening on the unlinked path; close it.
    await closeServer(initial);
    for (const s of spawnedNewServers) {
      try {
        await closeServer(s);
      } catch {
        /* already closed by race guard */
      }
    }
  });

  test("rebindIfMissing returns false and logs when listen() rejects", async () => {
    // Provide a factory whose listen() always errors, so rebindIfMissing
    // hits the catch branch.
    const initial = createServer();
    initial.on("error", () => {});
    await new Promise<void>((r) => {
      initial.once("listening", () => r());
      initial.listen(socketPath);
    });

    const rebinds: Array<{ newServer: Server; oldServer: Server }> = [];
    const loggedErrors: Array<{ obj: object; msg?: string }> = [];
    const failingFactory = () => {
      const s = createServer();
      s.on("error", () => {});
      // Replace listen to immediately error.
      const realListen = s.listen.bind(s);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s as any).listen = (_path: string) => {
        queueMicrotask(() => s.emit("error", new Error("simulated EADDRINUSE")));
        return s;
      };
      // Keep realListen reference alive so TS doesn't complain
      void realListen;
      return s;
    };

    const watchdog = new SocketWatchdog({
      socketPath,
      intervalMs: 0,
      getServer: () => initial,
      createServer: failingFactory,
      onRebind: (n, o) => rebinds.push({ newServer: n, oldServer: o }),
      log: {
        info: () => {},
        warn: () => {},
        error: (obj, msg) => loggedErrors.push({ obj, msg }),
      },
    });

    unlinkSync(socketPath);
    const rebound = await watchdog.rebindIfMissing();
    expect(rebound).toBe(false);
    expect(rebinds).toHaveLength(0);
    expect(loggedErrors.length).toBeGreaterThan(0);

    await closeServer(initial);
  });

  test("watchdog timer catches synchronous rebind errors so unhandled rejections don't escape", async () => {
    // createServer factory throws synchronously — simulates EACCES on
    // mkdir / a broken factory dependency.
    const throwingFactory = () => {
      throw new Error("boom — synchronous factory failure");
    };

    const initial = createServer();
    initial.on("error", () => {});
    await new Promise<void>((r) => {
      initial.once("listening", () => r());
      initial.listen(socketPath);
    });

    const loggedErrors: Array<{ obj: object; msg?: string }> = [];
    const watchdog = new SocketWatchdog({
      socketPath,
      intervalMs: 5,
      getServer: () => initial,
      createServer: throwingFactory,
      onRebind: () => {},
      log: {
        info: () => {},
        warn: () => {},
        error: (obj, msg) => loggedErrors.push({ obj, msg }),
      },
    });

    unlinkSync(socketPath);

    const seenRejections: unknown[] = [];
    const onRejection = (reason: unknown) => seenRejections.push(reason);
    process.on("unhandledRejection", onRejection);

    try {
      watchdog.start();
      // Let the timer fire several times.
      await new Promise((r) => setTimeout(r, 30));
      watchdog.stop();
    } finally {
      process.off("unhandledRejection", onRejection);
    }

    expect(seenRejections).toHaveLength(0);
    expect(loggedErrors.length).toBeGreaterThan(0);

    await closeServer(initial);
  });

  test("start() polls and rebinds without manual ticking", async () => {
    harness = buildHarness({ intervalMs: 10 });
    await startInitialServer(harness);
    harness.watchdog.start();

    unlinkSync(socketPath);

    // Wait up to 500ms for the timer to recover.
    const deadline = Date.now() + 500;
    while (harness.rebinds.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(harness.rebinds).toHaveLength(1);
    expect(existsSync(socketPath)).toBe(true);
  });

  test("stop() prevents future rebinds from firing", async () => {
    harness = buildHarness({ intervalMs: 10 });
    await startInitialServer(harness);
    harness.watchdog.start();

    // First recovery cycle.
    unlinkSync(socketPath);
    let deadline = Date.now() + 500;
    while (harness.rebinds.length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(harness.rebinds).toHaveLength(1);

    harness.watchdog.stop();
    const stoppedAt = harness.rebinds.length;

    // Unlink again. Wait three intervals; no new rebind should appear.
    unlinkSync(socketPath);
    await new Promise((r) => setTimeout(r, 50));
    expect(harness.rebinds).toHaveLength(stoppedAt);
    expect(existsSync(socketPath)).toBe(false);
  });
});
