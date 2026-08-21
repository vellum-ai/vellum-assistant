/**
 * The bridge's two safety properties: it never touches the plugin off
 * Capacitor iOS, and a shell too old to carry `WidgetSnapshot` is an expected
 * state rather than a fault. Every web deploy reaches installed shells that
 * predate the plugin, so a rejection there has to resolve as a silent debug
 * no-op; a caller that awaited a throw would break sign-out.
 *
 * Plus the producer id the bridge records beside the snapshot. The App Group
 * cache outlives the page, so it is the only thing a cold launch can use to
 * tell whose snapshot it inherited, and it has to track the writes that
 * actually landed.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { WidgetSnapshotPayload } from "./widget-snapshot";

let platform = "ios";
let pluginRejects = false;
const syncCalls: unknown[] = [];
let clearCalls = 0;

mock.module("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => platform,
  },
  registerPlugin: () => ({
    sync: async (options: unknown) => {
      syncCalls.push(options);
      if (pluginRejects) {
        throw new Error("WidgetSnapshot does not have an implementation");
      }
      return { ok: true };
    },
    clear: async () => {
      clearCalls += 1;
      if (pluginRejects) {
        throw new Error("WidgetSnapshot does not have an implementation");
      }
      return { ok: true };
    },
  }),
}));

const {
  clearWidgetSnapshot,
  isWidgetSnapshotSyncAvailable,
  readWidgetSnapshotAssistantId,
  syncWidgetSnapshot,
  WIDGET_SNAPSHOT_SCHEMA_VERSION,
} = await import("./widget-snapshot");

const SNAPSHOT: WidgetSnapshotPayload = {
  schemaVersion: WIDGET_SNAPSHOT_SCHEMA_VERSION,
  generatedAt: "2026-08-21T16:00:00.000Z",
  unreadCount: 2,
  inProgressCount: 1,
  conversations: [],
};

beforeEach(() => {
  platform = "ios";
  pluginRejects = false;
  syncCalls.length = 0;
  clearCalls = 0;
  localStorage.clear();
});

describe("widget-snapshot bridge", () => {
  it("passes the snapshot through on Capacitor iOS", async () => {
    expect(isWidgetSnapshotSyncAvailable()).toBe(true);
    await syncWidgetSnapshot(SNAPSHOT, "asst-1");
    await clearWidgetSnapshot();
    expect(syncCalls).toEqual([SNAPSHOT]);
    expect(clearCalls).toBe(1);
  });

  it("never reaches the plugin off Capacitor iOS", async () => {
    platform = "web";
    expect(isWidgetSnapshotSyncAvailable()).toBe(false);
    await syncWidgetSnapshot(SNAPSHOT, "asst-1");
    await clearWidgetSnapshot();
    expect(syncCalls).toHaveLength(0);
    expect(clearCalls).toBe(0);
    expect(readWidgetSnapshotAssistantId()).toBeNull();
  });

  it("resolves silently on a shell too old to carry the plugin", async () => {
    pluginRejects = true;
    await expect(
      syncWidgetSnapshot(SNAPSHOT, "asst-1"),
    ).resolves.toBeUndefined();
    await expect(clearWidgetSnapshot()).resolves.toBeUndefined();
  });
});

describe("the recorded snapshot producer", () => {
  it("is unknown until a snapshot is written, then names the producer", async () => {
    expect(readWidgetSnapshotAssistantId()).toBeNull();
    await syncWidgetSnapshot(SNAPSHOT, "asst-1");
    expect(readWidgetSnapshotAssistantId()).toBe("asst-1");
    await syncWidgetSnapshot(SNAPSHOT, "asst-2");
    expect(readWidgetSnapshotAssistantId()).toBe("asst-2");
  });

  it("is dropped with the snapshot on clear", async () => {
    await syncWidgetSnapshot(SNAPSHOT, "asst-1");
    await clearWidgetSnapshot();
    expect(readWidgetSnapshotAssistantId()).toBeNull();
  });

  it("still names the last landed write when the bridge rejects", async () => {
    // A rejected call changed nothing in the App Group, so the snapshot there
    // still belongs to whoever last wrote one.
    await syncWidgetSnapshot(SNAPSHOT, "asst-1");
    pluginRejects = true;
    await syncWidgetSnapshot(SNAPSHOT, "asst-2");
    expect(readWidgetSnapshotAssistantId()).toBe("asst-1");
    await clearWidgetSnapshot();
    expect(readWidgetSnapshotAssistantId()).toBe("asst-1");
  });

  it("reads as unknown when storage is unusable, and the sync still lands", async () => {
    // Private browsing, quota exhaustion, or storage disabled by policy.
    // happy-dom's Storage is a Proxy, so overwriting `setItem` on it just
    // writes an entry; swap the whole global instead.
    const original = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    )!;
    const throwing = {
      getItem: () => {
        throw new Error("localStorage unavailable");
      },
      setItem: () => {
        throw new Error("localStorage unavailable");
      },
      removeItem: () => {
        throw new Error("localStorage unavailable");
      },
    };
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => throwing,
    });
    try {
      await expect(
        syncWidgetSnapshot(SNAPSHOT, "asst-1"),
      ).resolves.toBeUndefined();
      await expect(clearWidgetSnapshot()).resolves.toBeUndefined();
      expect(readWidgetSnapshotAssistantId()).toBeNull();
      expect(syncCalls).toHaveLength(1);
      expect(clearCalls).toBe(1);
    } finally {
      Object.defineProperty(globalThis, "localStorage", original);
    }
  });
});
