import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { waitFor } from "../__tests__/helpers/wait-for.js";
import { createCesProcessManager } from "./process-manager.js";

const untilClosed = (predicate: () => boolean) =>
  waitFor(predicate, {
    timeoutMs: 2000,
    message: "socket close never propagated to the transport",
  });

let mockSocketPath = "";

function discoverTestSocket() {
  return Promise.resolve({
    mode: "managed" as const,
    socketPath: mockSocketPath,
  });
}

// ---------------------------------------------------------------------------
// onTransportClose tests
// ---------------------------------------------------------------------------

describe("CesProcessManager.onTransportClose", () => {
  let tempDir: string;
  let server: Server;
  let connections: Array<import("node:net").Socket>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "ces-pm-test-"));
    mockSocketPath = join(tempDir, "ces.sock");
    connections = [];
    // Create a Unix socket server that accepts connections but does nothing.
    server = createServer((socket) => {
      connections.push(socket);
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) =>
      server.listen(mockSocketPath, resolve),
    );
  });

  afterEach(async () => {
    // Destroy any lingering connections first so server.close() resolves.
    for (const sock of connections) {
      sock.destroy();
    }
    connections = [];
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("fires handler when the transport dies (socket closed)", async () => {
    const pm = createCesProcessManager({ discover: discoverTestSocket });
    const transport = await pm.start();
    expect(transport.isAlive()).toBe(true);

    let closeFired = false;
    pm.onTransportClose(() => {
      closeFired = true;
    });

    // Destroy the server-side socket → the client socket closes → transport dies.
    for (const sock of connections) {
      sock.destroy();
    }

    await untilClosed(() => closeFired);
    expect(transport.isAlive()).toBe(false);

    await pm.stop();
  });

  test("does not fire handler before the transport dies", async () => {
    const pm = createCesProcessManager({ discover: discoverTestSocket });
    await pm.start();

    let closeFired = false;
    pm.onTransportClose(() => {
      closeFired = true;
    });

    // Wait a bit — nothing should happen while the socket is alive.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closeFired).toBe(false);

    await pm.stop();
  });

  test("fires handler immediately if transport is already dead", async () => {
    const pm = createCesProcessManager({ discover: discoverTestSocket });
    const transport = await pm.start();

    // Kill the transport by destroying the server-side socket.
    for (const sock of connections) {
      sock.destroy();
    }
    await untilClosed(() => !transport.isAlive());

    // Register handler AFTER transport is already dead.
    let closeFired = false;
    pm.onTransportClose(() => {
      closeFired = true;
    });

    expect(closeFired).toBe(true);
    await pm.stop();
  });
});

// ---------------------------------------------------------------------------
// Transport-death logging: WARN only for genuinely-unexpected death
// ---------------------------------------------------------------------------

type LogCall = { level: string; msg: string };

function makeRecordingLogger(): {
  calls: LogCall[];
  logger: NonNullable<Parameters<typeof createCesProcessManager>[0]["logger"]>;
} {
  const calls: LogCall[] = [];
  const rec =
    (level: string) =>
    (...args: unknown[]) => {
      const msg = typeof args[0] === "string" ? args[0] : args[1];
      calls.push({ level, msg: typeof msg === "string" ? msg : "" });
    };
  const logger = {
    info: rec("info"),
    warn: rec("warn"),
    debug: rec("debug"),
    error: rec("error"),
  } as unknown as NonNullable<
    Parameters<typeof createCesProcessManager>[0]["logger"]
  >;
  return { calls, logger };
}

describe("CesProcessManager transport-death logging", () => {
  let tempDir: string;
  let server: Server;
  let connections: Array<import("node:net").Socket>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "ces-pm-log-test-"));
    mockSocketPath = join(tempDir, "ces.sock");
    connections = [];
    server = createServer((socket) => {
      connections.push(socket);
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) =>
      server.listen(mockSocketPath, resolve),
    );
  });

  afterEach(async () => {
    for (const sock of connections) {
      sock.destroy();
    }
    connections = [];
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("logs WARN when the transport dies unexpectedly (remote close)", async () => {
    const { calls, logger } = makeRecordingLogger();
    const pm = createCesProcessManager({
      logger,
      discover: discoverTestSocket,
    });
    const transport = await pm.start();

    // The remote (server) closes the connection: genuinely-unexpected death.
    for (const sock of connections) {
      sock.destroy();
    }
    await untilClosed(() =>
      calls.some(
        (c) => c.level === "warn" && c.msg.includes("died unexpectedly"),
      ),
    );
    expect(transport.isAlive()).toBe(false);

    await pm.stop();
  });

  test("does not log WARN on an intentional stop()", async () => {
    const { calls, logger } = makeRecordingLogger();
    const pm = createCesProcessManager({
      logger,
      discover: discoverTestSocket,
    });
    await pm.start();

    await pm.stop();
    await untilClosed(() =>
      calls.some(
        (c) =>
          c.level === "debug" && c.msg.includes("CES socket transport closed"),
      ),
    );

    expect(
      calls.some(
        (c) => c.level === "warn" && c.msg.includes("died unexpectedly"),
      ),
    ).toBe(false);
  });
});
