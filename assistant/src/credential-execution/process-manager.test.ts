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

import { createCesProcessManager } from "./process-manager.js";

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
    await new Promise<void>((resolve) => server.listen(mockSocketPath, resolve));
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

    // Give the close event a tick to propagate.
    await new Promise((resolve) => setTimeout(resolve, 50));

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
    await new Promise((resolve) => setTimeout(resolve, 50));
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
