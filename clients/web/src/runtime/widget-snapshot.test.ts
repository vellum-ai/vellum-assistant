/**
 * The bridge's two safety properties: it never touches the plugin off
 * Capacitor iOS, and a shell too old to carry `WidgetSnapshot` is an expected
 * state rather than a fault. Every web deploy reaches installed shells that
 * predate the plugin, so a rejection there has to resolve as a silent debug
 * no-op; a caller that awaited a throw would break sign-out.
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
});

describe("widget-snapshot bridge", () => {
  it("passes the snapshot through on Capacitor iOS", async () => {
    expect(isWidgetSnapshotSyncAvailable()).toBe(true);
    await syncWidgetSnapshot(SNAPSHOT);
    await clearWidgetSnapshot();
    expect(syncCalls).toEqual([SNAPSHOT]);
    expect(clearCalls).toBe(1);
  });

  it("never reaches the plugin off Capacitor iOS", async () => {
    platform = "web";
    expect(isWidgetSnapshotSyncAvailable()).toBe(false);
    await syncWidgetSnapshot(SNAPSHOT);
    await clearWidgetSnapshot();
    expect(syncCalls).toHaveLength(0);
    expect(clearCalls).toBe(0);
  });

  it("resolves silently on a shell too old to carry the plugin", async () => {
    pluginRejects = true;
    await expect(syncWidgetSnapshot(SNAPSHOT)).resolves.toBeUndefined();
    await expect(clearWidgetSnapshot()).resolves.toBeUndefined();
  });
});
