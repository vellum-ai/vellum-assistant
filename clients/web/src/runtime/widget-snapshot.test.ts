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
/** Rejects `clear` alone, leaving `sync` free to land. */
let clearRejects = false;
/** Simulates a shell that accepts the call and never answers it. */
let pluginHangs = false;
/** Holds `sync` open while set, so a clear can overtake a write in flight. */
let syncGate: Promise<void> | null = null;
/** Holds the NEXT `clear` open, so a write can overlap one still running. */
let clearGate: Promise<void> | null = null;
const syncCalls: unknown[] = [];
let clearCalls = 0;
/** Every bridge call in order, for the claims that are about ordering. */
let bridgeOrder: string[] = [];

mock.module("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => platform,
  },
  registerPlugin: () => ({
    sync: async (options: unknown) => {
      syncCalls.push(options);
      bridgeOrder.push("sync");
      if (pluginRejects) {
        throw new Error("WidgetSnapshot does not have an implementation");
      }
      if (syncGate !== null) {
        await syncGate;
      }
      if (pluginHangs) {
        await new Promise(() => {});
      }
      return { ok: true };
    },
    clear: async () => {
      clearCalls += 1;
      bridgeOrder.push("clear");
      // Consumed by the first clear that sees it, so a retry issued while one
      // is held open is not held open too.
      const gate = clearGate;
      clearGate = null;
      if (pluginRejects || clearRejects) {
        throw new Error("WidgetSnapshot does not have an implementation");
      }
      if (gate !== null) {
        await gate;
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

/** Drain the microtask queue, so calls in flight reach their next step. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await Promise.resolve();
  }
}

/**
 * Fire every pending wait, which is what the bridge timing out looks like.
 *
 * Looped, because a sync honors any owed clear before its own write and so
 * arms its timer only once that clear has given up.
 */
async function elapse(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await flush();
    const due = scheduled;
    scheduled = [];
    for (const fire of due) {
      fire();
    }
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
  retryPendingWidgetSnapshotClear,
  syncWidgetSnapshot,
  WIDGET_SNAPSHOT_SCHEMA_VERSION,
} = await import("./widget-snapshot");

/**
 * Run `body` with a `localStorage` that throws on every access: private
 * browsing, quota exhaustion, or storage disabled by policy. happy-dom's
 * Storage is a Proxy, so overwriting `setItem` on it just writes an entry;
 * swap the whole global instead.
 */
async function withUnusableStorage(body: () => Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
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
    await body();
  } finally {
    Object.defineProperty(globalThis, "localStorage", original);
  }
}

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
  clearRejects = false;
  pluginHangs = false;
  syncGate = null;
  clearGate = null;
  syncCalls.length = 0;
  clearCalls = 0;
  bridgeOrder = [];
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
    // Nothing to clear either, so the clear is complete by construction and
    // leaves no obligation behind on a platform that never had a snapshot.
    await expect(clearWidgetSnapshot()).resolves.toBe(true);
    await expect(retryPendingWidgetSnapshotClear()).resolves.toBe(true);
    expect(syncCalls).toHaveLength(0);
    expect(clearCalls).toBe(0);
    expect(readWidgetSnapshotAssistantId()).toBeNull();
  });

  it("resolves silently on a shell too old to carry the plugin", async () => {
    // Rejecting would break the session-ending callers that await these; both
    // callers still have to learn that nothing landed, so they report it
    // rather than throwing it.
    pluginRejects = true;
    await expect(syncWidgetSnapshot(SNAPSHOT, "asst-1")).resolves.toBe(false);
    await expect(clearWidgetSnapshot()).resolves.toBe(false);
  });

  it("gives up on a bridge call that is accepted and never answered", async () => {
    // Sign-out awaits the clear before it writes the signed-out state, so a
    // call that never settles would hang the sign-out itself.
    pluginHangs = true;
    captureTimeouts();

    const cleared = clearWidgetSnapshot();
    await elapse();
    await expect(cleared).resolves.toBe(false);

    const synced = syncWidgetSnapshot(SNAPSHOT, "asst-1");
    await elapse();
    // A timed-out write is reported the same way a rejected one is: the App
    // Group was not updated, so the producer must be free to try again.
    await expect(synced).resolves.toBe(false);
    expect(syncCalls).toHaveLength(1);
  });

  it("leaves the recorded producer alone when a call times out", async () => {
    // Nothing is known to have changed in the App Group, so the snapshot
    // there still belongs to whoever last wrote one.
    await syncWidgetSnapshot(SNAPSHOT, "asst-1");
    pluginHangs = true;
    captureTimeouts();

    const cleared = clearWidgetSnapshot();
    await elapse();
    await cleared;

    expect(readWidgetSnapshotAssistantId()).toBe("asst-1");
  });
});

describe("a clear that did not land", () => {
  it("keeps the producer record and finishes on the next use of the module", async () => {
    await syncWidgetSnapshot(SNAPSHOT, "asst-1");
    pluginRejects = true;
    await expect(clearWidgetSnapshot()).resolves.toBe(false);
    // The App Group was not touched, so the snapshot still belongs to whoever
    // wrote it and the cold-boot ownership check must still be able to say so.
    // Dropping the record here is what would strand it as an orphan.
    expect(readWidgetSnapshotAssistantId()).toBe("asst-1");
    expect(clearCalls).toBe(1);

    // The obligation outlives the attempt, so the drop is at-least-once rather
    // than lost with the session that owed it.
    pluginRejects = false;
    await expect(retryPendingWidgetSnapshotClear()).resolves.toBe(true);
    expect(clearCalls).toBe(2);
    expect(readWidgetSnapshotAssistantId()).toBeNull();

    // And once it is finished, nothing is owed.
    await expect(retryPendingWidgetSnapshotClear()).resolves.toBe(true);
    expect(clearCalls).toBe(2);
  });

  it("owes nothing once a clear lands", async () => {
    await syncWidgetSnapshot(SNAPSHOT, "asst-1");
    await expect(clearWidgetSnapshot()).resolves.toBe(true);
    expect(readWidgetSnapshotAssistantId()).toBeNull();

    await retryPendingWidgetSnapshotClear();
    expect(clearCalls).toBe(1);
  });

  it("is finished before the next session's first write", async () => {
    // The launch this is all for: the previous session could not drop its
    // snapshot, and the next one signs in as somebody else. The owed clear has
    // to run ahead of the new write, since a clear issued alongside it could
    // otherwise land after and wipe the snapshot that write just made.
    pluginRejects = true;
    await clearWidgetSnapshot();
    pluginRejects = false;

    await expect(syncWidgetSnapshot(SNAPSHOT, "asst-2")).resolves.toBe(true);
    expect(bridgeOrder).toEqual(["clear", "clear", "sync"]);
    expect(readWidgetSnapshotAssistantId()).toBe("asst-2");
  });

  it("is discharged by a landed sync the retry itself could not manage", async () => {
    // The plugin REPLACES the App Group record rather than merging into it, so
    // a write that lands leaves nothing of the payload the clear was owed for.
    // Without that equivalence a bridge whose clear keeps failing would owe one
    // forever, re-clearing every snapshot the session went on to write.
    clearRejects = true;
    await expect(clearWidgetSnapshot()).resolves.toBe(false);
    await expect(syncWidgetSnapshot(SNAPSHOT, "asst-2")).resolves.toBe(true);
    expect(readWidgetSnapshotAssistantId()).toBe("asst-2");

    const clearsSoFar = clearCalls;
    await syncWidgetSnapshot(SNAPSHOT, "asst-2");
    expect(clearCalls).toBe(clearsSoFar);
  });

  it("is re-armed for a write that lands while a clear is still open", async () => {
    // Sign-out's clear is slow, so the write that overlaps it honors the
    // obligation it sees, writes, and lands before that clear has finished.
    // A generation that only moved when a clear STARTED would read back
    // unchanged here and let this write take itself for uncontested.
    let openClear = (): void => {};
    clearGate = new Promise<void>((resolve) => {
      openClear = resolve;
    });
    const cleared = clearWidgetSnapshot();
    await flush();

    let openSync = (): void => {};
    syncGate = new Promise<void>((resolve) => {
      openSync = resolve;
    });
    const synced = syncWidgetSnapshot(SNAPSHOT, "asst-1");
    await flush();

    openClear();
    await expect(cleared).resolves.toBe(true);
    openSync();
    await expect(synced).resolves.toBe(true);
    expect(readWidgetSnapshotAssistantId()).toBeNull();

    const clearsSoFar = clearCalls;
    await retryPendingWidgetSnapshotClear();
    expect(clearCalls).toBe(clearsSoFar + 1);
  });

  it("is re-armed for a write that lands after a clear started", async () => {
    // The producer hook's sync and a sign-out's clear overlap freely, and such
    // a write can land on either side of the clear. What it leaves therefore
    // belongs to the session that just ended: the clear it raced already
    // dropped the producer record, so the obligation is the only thing left
    // that can reach the orphan.
    let openSync = (): void => {};
    syncGate = new Promise<void>((resolve) => {
      openSync = resolve;
    });
    const synced = syncWidgetSnapshot(SNAPSHOT, "asst-1");
    await flush();

    await expect(clearWidgetSnapshot()).resolves.toBe(true);
    openSync();
    await expect(synced).resolves.toBe(true);
    expect(readWidgetSnapshotAssistantId()).toBeNull();

    const clearsSoFar = clearCalls;
    await retryPendingWidgetSnapshotClear();
    expect(clearCalls).toBe(clearsSoFar + 1);
  });

  it("degrades to nothing owed when storage refuses the marker", async () => {
    // Best-effort like every other write here: a session seam must not throw
    // because storage is unusable, and what is left is the producer-id
    // machinery it was reinforcing.
    await withUnusableStorage(async () => {
      pluginRejects = true;
      await expect(clearWidgetSnapshot()).resolves.toBe(false);
      pluginRejects = false;
      await expect(retryPendingWidgetSnapshotClear()).resolves.toBe(true);
      expect(clearCalls).toBe(1);
      await expect(syncWidgetSnapshot(SNAPSHOT, "asst-1")).resolves.toBe(true);
      expect(bridgeOrder).toEqual(["clear", "sync"]);
    });
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
    await withUnusableStorage(async () => {
      await expect(syncWidgetSnapshot(SNAPSHOT, "asst-1")).resolves.toBe(true);
      await expect(clearWidgetSnapshot()).resolves.toBe(true);
      expect(readWidgetSnapshotAssistantId()).toBeNull();
      expect(syncCalls).toHaveLength(1);
      expect(clearCalls).toBe(1);
    });
  });
});
