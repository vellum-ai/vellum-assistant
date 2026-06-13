import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

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
}));

// ---------------------------------------------------------------------------
// Track calls to publishSyncInvalidation so we can assert the listener
// fans flag changes out onto the SSE hub.
// ---------------------------------------------------------------------------
let publishedTagSets: string[][] = [];

mock.module("../runtime/sync/sync-publisher.js", () => ({
  publishSyncInvalidation: async (tags: string[]) => {
    publishedTagSets.push([...tags]);
    return { type: "sync_changed", tags };
  },
}));

// ---------------------------------------------------------------------------
// Track calls to syncFlagGatedTools so we can assert the listener registers
// newly-enabled flag-gated tools after a runtime refresh (not just the cache).
// ---------------------------------------------------------------------------
let syncToolsCallCount = 0;

mock.module("../tools/registry.js", () => ({
  syncFlagGatedTools: async () => {
    syncToolsCallCount++;
  },
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after mock.module)
// ---------------------------------------------------------------------------
const { startGatewayFlagListener, stopGatewayFlagListener } =
  await import("../ipc/gateway-flag-listener.js");

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
    syncToolsCallCount = 0;
    publishedTagSets = [];
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

  test("refreshes flag cache AND syncs gated tools on connect and on feature_flags_changed event", async () => {
    await new Promise<void>((resolve) => {
      testServer.server.listen(socketPath, resolve);
    });

    startGatewayFlagListener();
    await testServer.waitForClient();
    await new Promise((r) => setTimeout(r, 100));

    expect(refreshCallCount).toBe(1);
    // Connect must also sync gated tools, so a flag flipped while disconnected
    // registers its tools without waiting for a restart.
    expect(syncToolsCallCount).toBe(1);

    testServer.emit("feature_flags_changed");
    await new Promise((r) => setTimeout(r, 100));

    expect(refreshCallCount).toBe(2);
    // The runtime flag change must register newly-enabled tools too — not just
    // refresh the cache (the bug: routes pass the gate but tools stay absent).
    expect(syncToolsCallCount).toBe(2);
  });

  test("broadcasts feature-flags sync_changed when flags change", async () => {
    await new Promise<void>((resolve) => {
      testServer.server.listen(socketPath, resolve);
    });

    startGatewayFlagListener();
    await testServer.waitForClient();
    await new Promise((r) => setTimeout(r, 100));

    // Connect refresh should not broadcast — only an actual change does.
    expect(publishedTagSets.length).toBe(0);

    testServer.emit("feature_flags_changed");
    await new Promise((r) => setTimeout(r, 100));

    expect(publishedTagSets.length).toBe(1);
    expect(publishedTagSets[0]).toEqual([
      "feature-flags:client",
      "feature-flags:assistant",
    ]);
  });

  test("ignores non-flag events", async () => {
    await new Promise<void>((resolve) => {
      testServer.server.listen(socketPath, resolve);
    });

    startGatewayFlagListener();
    await testServer.waitForClient();
    await new Promise((r) => setTimeout(r, 100));

    const countAfterConnect = refreshCallCount;

    testServer.emit("some_other_event");
    await new Promise((r) => setTimeout(r, 100));

    expect(refreshCallCount).toBe(countAfterConnect);
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

    await new Promise((r) => setTimeout(r, 100));
    const countAfterReconnect = refreshCallCount;
    expect(countAfterReconnect).toBeGreaterThan(0);

    const payload = JSON.stringify({ event: "feature_flags_changed" }) + "\n";
    secondClient!.write(payload);
    await new Promise((r) => setTimeout(r, 200));

    expect(refreshCallCount).toBe(countAfterReconnect + 1);
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
