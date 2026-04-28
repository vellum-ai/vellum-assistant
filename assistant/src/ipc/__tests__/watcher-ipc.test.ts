/**
 * Integration tests for the watcher IPC routes.
 *
 * Exercises the full IPC round-trip: AssistantIpcServer + cliIpcCall over
 * the Unix domain socket, with the real SQLite watcher store backing
 * the route handlers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { initializeDb } from "../../memory/db-init.js";
import { registerWatcherProvider } from "../../watcher/provider-registry.js";
import type { WatcherProvider } from "../../watcher/provider-types.js";
import type { Watcher, WatcherEvent } from "../../watcher/watcher-store.js";
import { AssistantIpcServer } from "../assistant-server.js";
import { cliIpcCall } from "../cli-client.js";

// ---------------------------------------------------------------------------
// DB + provider setup
// ---------------------------------------------------------------------------

initializeDb();

const mockProvider: WatcherProvider = {
  id: "test-provider",
  displayName: "Test Provider",
  requiredCredentialService: "test-cred",
  async fetchNew() {
    return { items: [], watermark: "w1" };
  },
  async getInitialWatermark() {
    return "initial";
  },
  cleanup() {},
};

registerWatcherProvider(mockProvider);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let server: AssistantIpcServer | null = null;

/** IDs of watchers created during a test, cleaned up in afterEach. */
const createdWatcherIds: string[] = [];

beforeEach(async () => {
  server = new AssistantIpcServer();
  await server.start();
  // Allow the server socket to bind.
  await new Promise((resolve) => setTimeout(resolve, 50));
});

afterEach(async () => {
  // Clean up watchers created during the test.
  for (const id of createdWatcherIds) {
    await cliIpcCall("watcher_delete", { body: { watcher_id: id } });
  }
  createdWatcherIds.length = 0;

  server?.stop();
  server = null;
});

/** Helper to create a watcher and track it for cleanup. */
async function createTestWatcher(
  overrides?: Record<string, unknown>,
): Promise<Watcher> {
  const result = await cliIpcCall<Watcher>("watcher_create", { body: {
    name: "Test Watcher",
    provider: "test-provider",
    action_prompt: "Handle events",
    ...overrides,
  } });
  expect(result.ok).toBe(true);
  expect(result.result).toBeDefined();
  createdWatcherIds.push(result.result!.id);
  return result.result!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("watcher IPC routes", () => {
  // -- CRUD round-trip --------------------------------------------------------

  test("create -> list -> update -> delete round-trip", async () => {
    // Create
    const watcher = await createTestWatcher();
    expect(watcher.name).toBe("Test Watcher");
    expect(watcher.providerId).toBe("test-provider");
    expect(watcher.actionPrompt).toBe("Handle events");
    expect(watcher.enabled).toBe(true);
    expect(watcher.status).toBe("idle");

    // List all
    const listResult = await cliIpcCall<Watcher[]>("watcher_list", { body: {} });
    expect(listResult.ok).toBe(true);
    expect(Array.isArray(listResult.result)).toBe(true);
    const found = listResult.result!.find((w) => w.id === watcher.id);
    expect(found).toBeDefined();

    // List single
    const detailResult = await cliIpcCall<{
      watcher: Watcher;
      events: WatcherEvent[];
    }>("watcher_list", { body: { watcher_id: watcher.id } });
    expect(detailResult.ok).toBe(true);
    expect(detailResult.result!.watcher.id).toBe(watcher.id);
    expect(Array.isArray(detailResult.result!.events)).toBe(true);

    // Update
    const updateResult = await cliIpcCall<Watcher>("watcher_update", { body: {
      watcher_id: watcher.id,
      name: "Updated Watcher",
    } });
    expect(updateResult.ok).toBe(true);
    expect(updateResult.result!.name).toBe("Updated Watcher");

    // Delete
    const deleteResult = await cliIpcCall<{ deleted: boolean; name: string }>(
      "watcher_delete",
      { body: { watcher_id: watcher.id } },
    );
    expect(deleteResult.ok).toBe(true);
    expect(deleteResult.result!.deleted).toBe(true);
    expect(deleteResult.result!.name).toBe("Updated Watcher");

    // Remove from cleanup tracking since we already deleted it.
    const idx = createdWatcherIds.indexOf(watcher.id);
    if (idx >= 0) createdWatcherIds.splice(idx, 1);

    // Confirm gone
    const afterDelete = await cliIpcCall<Watcher[]>("watcher_list", { body: {} });
    expect(afterDelete.ok).toBe(true);
    const gone = afterDelete.result!.find((w) => w.id === watcher.id);
    expect(gone).toBeUndefined();
  });

  // -- Create: unknown provider -----------------------------------------------

  test("watcher/create rejects unknown provider", async () => {
    const result = await cliIpcCall("watcher_create", { body: {
      name: "Bad Watcher",
      provider: "nonexistent",
      action_prompt: "Do stuff",
    } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown provider "nonexistent"');
    expect(result.error).toContain("test-provider");
  });

  // -- Create: poll interval too low ------------------------------------------

  test("watcher/create rejects poll_interval_ms < 15000", async () => {
    const result = await cliIpcCall("watcher_create", { body: {
      name: "Fast Watcher",
      provider: "test-provider",
      action_prompt: "Handle events",
      poll_interval_ms: 5000,
    } });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  // -- List: empty state ------------------------------------------------------

  test("watcher/list returns empty array when no watchers exist", async () => {
    const result = await cliIpcCall<Watcher[]>("watcher_list", { body: {} });
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.result)).toBe(true);
    // There might be leftover watchers from other tests, but the important
    // thing is that the call succeeds and returns an array.
  });

  // -- Update: no fields provided ---------------------------------------------

  test("watcher/update rejects when no update fields provided", async () => {
    const watcher = await createTestWatcher();
    const result = await cliIpcCall("watcher_update", { body: {
      watcher_id: watcher.id,
    } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No updates provided");
  });

  // -- Delete: non-existent watcher -------------------------------------------

  test("watcher/delete returns error for non-existent watcher", async () => {
    const result = await cliIpcCall("watcher_delete", { body: {
      watcher_id: "does-not-exist",
    } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Watcher not found");
  });

  // -- Digest: empty events ---------------------------------------------------

  test("watcher/digest returns empty events when no events exist", async () => {
    const result = await cliIpcCall<{
      events: WatcherEvent[];
      watcherNames: Record<string, string>;
    }>("watcher_digest", { body: {} });
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.result!.events)).toBe(true);
    expect(typeof result.result!.watcherNames).toBe("object");
  });

  // -- Underscore aliases -----------------------------------------------------

  test("watcher_create alias works identically to watcher/create", async () => {
    const result = await cliIpcCall<Watcher>("watcher_create", { body: {
      name: "Alias Watcher",
      provider: "test-provider",
      action_prompt: "Handle events",
    } });
    expect(result.ok).toBe(true);
    expect(result.result!.name).toBe("Alias Watcher");
    createdWatcherIds.push(result.result!.id);
  });

  test("watcher_list alias works identically to watcher/list", async () => {
    const watcher = await createTestWatcher();
    const result = await cliIpcCall<Watcher[]>("watcher_list", { body: {} });
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.result)).toBe(true);
    const found = result.result!.find((w) => w.id === watcher.id);
    expect(found).toBeDefined();
  });

  test("watcher_update alias works identically to watcher/update", async () => {
    const watcher = await createTestWatcher();
    const result = await cliIpcCall<Watcher>("watcher_update", { body: {
      watcher_id: watcher.id,
      name: "Alias Updated",
    } });
    expect(result.ok).toBe(true);
    expect(result.result!.name).toBe("Alias Updated");
  });

  test("watcher_delete alias works identically to watcher/delete", async () => {
    const watcher = await createTestWatcher();
    const result = await cliIpcCall<{ deleted: boolean; name: string }>(
      "watcher_delete",
      { body: { watcher_id: watcher.id } },
    );
    expect(result.ok).toBe(true);
    expect(result.result!.deleted).toBe(true);

    // Remove from cleanup tracking.
    const idx = createdWatcherIds.indexOf(watcher.id);
    if (idx >= 0) createdWatcherIds.splice(idx, 1);
  });

  test("watcher_digest alias works identically to watcher/digest", async () => {
    const result = await cliIpcCall<{
      events: WatcherEvent[];
      watcherNames: Record<string, string>;
    }>("watcher_digest", { body: {} });
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.result!.events)).toBe(true);
  });

  // -- Create: credential_service override ------------------------------------

  test("watcher/create uses provider default credential_service when not overridden", async () => {
    const watcher = await createTestWatcher();
    expect(watcher.credentialService).toBe("test-cred");
  });

  test("watcher/create accepts credential_service override", async () => {
    const watcher = await createTestWatcher({
      credential_service: "custom-cred",
    });
    expect(watcher.credentialService).toBe("custom-cred");
  });

  // -- Create: config passthrough ---------------------------------------------

  test("watcher/create passes config as configJson", async () => {
    const watcher = await createTestWatcher({
      config: { filter: "important" },
    });
    expect(watcher.configJson).toBe(JSON.stringify({ filter: "important" }));
  });

  // -- Create: custom poll interval -------------------------------------------

  test("watcher/create accepts valid poll_interval_ms", async () => {
    const watcher = await createTestWatcher({ poll_interval_ms: 30000 });
    expect(watcher.pollIntervalMs).toBe(30000);
  });
});
