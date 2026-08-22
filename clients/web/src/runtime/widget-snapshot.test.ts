/**
 * The bridge's three safety properties: it never touches the plugin off
 * Capacitor iOS, a shell too old to carry `WidgetSnapshot` is an expected
 * state rather than a fault, and a call that is accepted but never answered
 * gives up rather than waiting forever. Every web deploy reaches installed
 * shells that predate the plugin, so a rejection there has to resolve as a
 * silent debug no-op; and every session-ending path awaits these calls before
 * the state write that signs the user out, so a caller that awaited a throw
 * (or a promise that never settles) would break sign-out.
 *
 * Plus the producer id the bridge records beside the snapshot. The App Group
 * cache outlives the page, so it is the only thing a cold launch can use to
 * tell whose snapshot it inherited, and it has to track the writes that
 * actually landed.
 *
 * A sync also reports whether its write landed, since the producer hook dedupes
 * on the payload it last sent and would otherwise arm that key for a write the
 * bridge rejected or never answered, leaving a stale snapshot on the Home
 * Screen until the conversation data itself changed.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import type { WidgetSnapshotPayload } from "./widget-snapshot";

let platform = "ios";
let pluginRejects = false;
/** Simulates a shell that accepts the call and never answers it. */
let pluginHangs = false;
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
      if (pluginHangs) {
        await new Promise(() => {});
      }
      return { ok: true };
    },
    clear: async () => {
      clearCalls += 1;
      if (pluginRejects) {
        throw new Error("WidgetSnapshot does not have an implementation");
      }
      if (pluginHangs) {
        await new Promise(() => {});
      }
      return { ok: true };
    },
  }),
}));

// bun:test ships no `vi.useFakeTimers()` equivalent, so the module's own
// timeout is driven by swapping the global: the wait is captured and fired on
// demand instead of costing the suite its real two seconds.
let scheduled: (() => void)[] = [];
let captured = false;
let realSetTimeout: typeof globalThis.setTimeout;
let realClearTimeout: typeof globalThis.clearTimeout;

/** Fire every pending wait, which is what the bridge timing out looks like. */
function elapse(): void {
  const due = scheduled;
  scheduled = [];
  for (const fire of due) {
    fire();
  }
}

function captureTimeouts(): void {
  realSetTimeout = globalThis.setTimeout;
  realClearTimeout = globalThis.clearTimeout;
  captured = true;
  globalThis.setTimeout = ((fn: () => void) => {
    scheduled.push(fn);
    return scheduled.length as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof globalThis.clearTimeout;
}

function releaseTimeouts(): void {
  if (!captured) {
    return;
  }
  captured = false;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  scheduled = [];
}

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
  pluginHangs = false;
  syncCalls.length = 0;
  clearCalls = 0;
  localStorage.clear();
});

afterEach(() => {
  releaseTimeouts();
});

describe("widget-snapshot bridge", () => {
  it("passes the snapshot through on Capacitor iOS", async () => {
    expect(isWidgetSnapshotSyncAvailable()).toBe(true);
    await expect(syncWidgetSnapshot(SNAPSHOT, "asst-1")).resolves.toBe(true);
    await clearWidgetSnapshot();
    expect(syncCalls).toEqual([SNAPSHOT]);
    expect(clearCalls).toBe(1);
  });

  it("never reaches the plugin off Capacitor iOS", async () => {
    platform = "web";
    expect(isWidgetSnapshotSyncAvailable()).toBe(false);
    // Nothing was written, so nothing landed.
    await expect(syncWidgetSnapshot(SNAPSHOT, "asst-1")).resolves.toBe(false);
    await clearWidgetSnapshot();
    expect(syncCalls).toHaveLength(0);
    expect(clearCalls).toBe(0);
    expect(readWidgetSnapshotAssistantId()).toBeNull();
  });

  it("resolves silently on a shell too old to carry the plugin", async () => {
    // Rejecting would break the session-ending callers that await these; the
    // producer hook still has to learn that nothing landed, so the sync
    // reports it rather than throwing it.
    pluginRejects = true;
    await expect(syncWidgetSnapshot(SNAPSHOT, "asst-1")).resolves.toBe(false);
    await expect(clearWidgetSnapshot()).resolves.toBeUndefined();
  });

  it("gives up on a bridge call that is accepted and never answered", async () => {
    // Sign-out awaits the clear before it writes the signed-out state, so a
    // call that never settles would hang the sign-out itself.
    pluginHangs = true;
    captureTimeouts();

    const cleared = clearWidgetSnapshot();
    const synced = syncWidgetSnapshot(SNAPSHOT, "asst-1");
    elapse();

    await expect(cleared).resolves.toBeUndefined();
    // A timed-out write is reported the same way a rejected one is: the App
    // Group was not updated, so the producer must be free to try again.
    await expect(synced).resolves.toBe(false);
    expect(clearCalls).toBe(1);
    expect(syncCalls).toHaveLength(1);
  });

  it("leaves the recorded producer alone when a call times out", async () => {
    // Nothing is known to have changed in the App Group, so the snapshot
    // there still belongs to whoever last wrote one.
    await syncWidgetSnapshot(SNAPSHOT, "asst-1");
    pluginHangs = true;
    captureTimeouts();

    const cleared = clearWidgetSnapshot();
    elapse();
    await cleared;

    expect(readWidgetSnapshotAssistantId()).toBe("asst-1");
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
      await expect(syncWidgetSnapshot(SNAPSHOT, "asst-1")).resolves.toBe(true);
      await expect(clearWidgetSnapshot()).resolves.toBeUndefined();
      expect(readWidgetSnapshotAssistantId()).toBeNull();
      expect(syncCalls).toHaveLength(1);
      expect(clearCalls).toBe(1);
    } finally {
      Object.defineProperty(globalThis, "localStorage", original);
    }
  });
});
