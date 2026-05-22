import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Isolated temp directory for the IPC socket
// ---------------------------------------------------------------------------
const testRoot = mkdtempSync(join(tmpdir(), "flag-listener-test-"));
const socketPath = join(testRoot, "gateway.sock");

// ---------------------------------------------------------------------------
// Mock socket-path resolution to use our test socket
// ---------------------------------------------------------------------------
mock.module("../ipc/socket-path.js", () => ({
  resolveIpcSocketPath: (_name: string) => ({
    path: socketPath,
    source: "workspace" as const,
  }),
  getAssistantSocketPath: () => join(testRoot, "assistant.sock"),
}));

// ---------------------------------------------------------------------------
// Track calls to refreshOverridesFromGateway
// ---------------------------------------------------------------------------
let refreshCallCount = 0;

mock.module("../config/assistant-feature-flags.js", () => ({
  refreshOverridesFromGateway: async () => {
    refreshCallCount++;
  },
  initFeatureFlagOverrides: async () => {},
  clearFeatureFlagOverridesCache: () => {},
  isAssistantFeatureFlagEnabled: () => true,
  _setOverridesForTesting: () => {},
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after mock.module)
// ---------------------------------------------------------------------------
const { startGatewayFlagListener, stopGatewayFlagListener } = await import(
  "../ipc/gateway-flag-listener.js"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestServer(): {
  server: Server;
  clients: Set<Socket>;
  emit: (event: string, data?: unknown) => void;
  waitForClient: () => Promise<Socket>;
} {
  const clients = new Set<Socket>();
  const clientWaiters: Array<(socket: Socket) => void> = [];

  const server = createServer((socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    const waiter = clientWaiters.shift();
    if (waiter) waiter(socket);
  });

  return {
    server,
    clients,
    emit: (event: string, data?: unknown) => {
      const payload = JSON.stringify({ event, data }) + "\n";
      for (const client of clients) {
        if (!client.destroyed) client.write(payload);
      }
    },
    waitForClient: () =>
      new Promise((resolve) => {
        if (clients.size > 0) {
          resolve(clients.values().next().value!);
          return;
        }
        clientWaiters.push(resolve);
      }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("gateway-flag-listener", () => {
  let testServer: ReturnType<typeof createTestServer>;

  beforeEach(() => {
    mkdirSync(testRoot, { recursive: true });
    refreshCallCount = 0;
    testServer = createTestServer();
  });

  afterEach(async () => {
    stopGatewayFlagListener();
    await new Promise<void>((resolve) => {
      for (const client of testServer.clients) {
        if (!client.destroyed) client.destroy();
      }
      testServer.server.close(() => resolve());
    });
    try {
      rmSync(socketPath, { force: true });
    } catch {
      // best effort
    }
  });

  test("refreshes flag cache on feature_flags_changed event", async () => {
    await new Promise<void>((resolve) => {
      testServer.server.listen(socketPath, resolve);
    });

    startGatewayFlagListener();
    await testServer.waitForClient();

    testServer.emit("feature_flags_changed");
    await new Promise((r) => setTimeout(r, 100));

    expect(refreshCallCount).toBe(1);
  });

  test("ignores non-flag events", async () => {
    await new Promise<void>((resolve) => {
      testServer.server.listen(socketPath, resolve);
    });

    startGatewayFlagListener();
    await testServer.waitForClient();

    testServer.emit("some_other_event");
    await new Promise((r) => setTimeout(r, 100));

    expect(refreshCallCount).toBe(0);
  });

  test("reconnects on disconnect and handles events on new connection", async () => {
    await new Promise<void>((resolve) => {
      testServer.server.listen(socketPath, resolve);
    });

    startGatewayFlagListener();
    const firstClient = await testServer.waitForClient();

    // Wait for the close event to propagate back to the server before
    // setting up the next waitForClient — otherwise waitForClient might
    // resolve with the old (now-destroyed) socket that is still in the set.
    await new Promise<void>((resolve) => {
      firstClient.on("close", resolve);
      firstClient.destroy();
    });

    // Wait for reconnect (initial backoff is 1s)
    const secondClient = await Promise.race([
      testServer.waitForClient(),
      new Promise<null>((r) => setTimeout(() => r(null), 3000)),
    ]);

    expect(secondClient).not.toBeNull();

    refreshCallCount = 0;
    const payload =
      JSON.stringify({ event: "feature_flags_changed" }) + "\n";
    secondClient!.write(payload);
    await new Promise((r) => setTimeout(r, 200));

    expect(refreshCallCount).toBe(1);
  });

  test("stopGatewayFlagListener cleans up and does not reconnect", async () => {
    await new Promise<void>((resolve) => {
      testServer.server.listen(socketPath, resolve);
    });

    startGatewayFlagListener();
    await testServer.waitForClient();

    stopGatewayFlagListener();
    await new Promise((r) => setTimeout(r, 50));

    const initialClientCount = testServer.clients.size;

    // Wait past reconnect backoff — should not reconnect
    await new Promise((r) => setTimeout(r, 1500));

    expect(testServer.clients.size).toBeLessThanOrEqual(initialClientCount);
  });
});
