import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { createCesProcessManager, logCesLine } from "./process-manager.js";

// Poll until `predicate` holds or the deadline passes. Fixed sleeps flake on
// loaded CI runners where socket-close events take >50ms to propagate.
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeLogger() {
  return {
    debug: mock((_obj: object, _msg: string) => {}),
    info: mock((_obj: object, _msg: string) => {}),
    warn: mock((_obj: object, _msg: string) => {}),
    error: mock((_obj: object, _msg: string) => {}),
  };
}

describe("logCesLine", () => {
  test("pino JSON INFO line routes to log.info (not log.error)", () => {
    const logger = makeLogger();
    const line = JSON.stringify({
      level: 30,
      msg: "CES ready",
      time: Date.now(),
    });

    logCesLine(line, 42, logger);

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();

    const [meta, msg] = logger.info.mock.calls[0] as [object, string];
    expect(meta).toEqual({ pid: 42 });
    expect(msg).toBe(`[ces-stderr] ${line}`);
  });

  test("pino JSON ERROR line routes to log.error", () => {
    const logger = makeLogger();
    const line = JSON.stringify({
      level: 50,
      msg: "credential store failed",
      time: Date.now(),
    });

    logCesLine(line, 42, logger);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });

  test("non-JSON fragment like 'args: []' routes to log.info", () => {
    const logger = makeLogger();

    logCesLine("args: []", 42, logger);

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();

    const [meta, msg] = logger.info.mock.calls[0] as [object, string];
    expect(meta).toEqual({ pid: 42 });
    expect(msg).toBe("[ces-stderr] args: []");
  });

  test("non-JSON line starting with 'ERROR:' routes to log.error", () => {
    const logger = makeLogger();

    logCesLine("ERROR: bad thing happened", 42, logger);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });

  test("pino-pretty timestamped ERROR line routes to log.error", () => {
    const logger = makeLogger();

    logCesLine("[12:07:37.467] ERROR oh no", 42, logger);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });

  test("pino-pretty timestamped WARN line routes to log.warn", () => {
    const logger = makeLogger();

    logCesLine("[12:07:37.467] WARN wat", 42, logger);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });

  test("pino-pretty timestamped INFO line routes to log.info", () => {
    const logger = makeLogger();

    logCesLine("[12:07:37.467] INFO starting", 42, logger);

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// onTransportClose tests
// ---------------------------------------------------------------------------

// Mock executable-discovery so start() connects to our test socket.
const realDiscovery = await import("./executable-discovery.js");

let mockSocketPath = "";

mock.module("./executable-discovery.js", () => ({
  ...realDiscovery,
  discoverCesWithRetry: async () => ({
    mode: "sibling" as const,
    socketPath: mockSocketPath,
  }),
  isCesSiblingOptIn: () => true,
  discoverLocalCes: () => ({
    mode: "unavailable" as const,
    reason: "mocked",
  }),
}));

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

  afterAll(() => {
    mock.module("./executable-discovery.js", () => realDiscovery);
  });

  test("fires handler when the transport dies (socket closed)", async () => {
    const pm = createCesProcessManager({});
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

    // Wait for the close event to propagate (poll — timing varies on CI).
    await waitFor(() => closeFired);

    expect(closeFired).toBe(true);
    expect(transport.isAlive()).toBe(false);

    await pm.stop();
  });

  test("does not fire handler before the transport dies", async () => {
    const pm = createCesProcessManager({});
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
    const pm = createCesProcessManager({});
    const transport = await pm.start();

    // Kill the transport by destroying the server-side socket.
    for (const sock of connections) {
      sock.destroy();
    }
    await waitFor(() => !transport.isAlive());
    expect(transport.isAlive()).toBe(false);

    // Register handler AFTER transport is already dead.
    let closeFired = false;
    pm.onTransportClose(() => {
      closeFired = true;
    });

    expect(closeFired).toBe(true);
    await pm.stop();
  });
});
