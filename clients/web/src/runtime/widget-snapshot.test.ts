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
 * Screen until the conversation data itself changed. Landed means durably: a
 * write a session-ending clear ran across is taken straight back out and
 * reported as not landed, while one merely superseded or left behind by an
 * unmount stays where it is and is reported as the App Group content it is.
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
  avatar: { kind: "character", accentHex: "#E9642F", imageBase64: null },
};

/** A later payload from the same producer, so one write can supersede another. */
const NEWER_SNAPSHOT: WidgetSnapshotPayload = { ...SNAPSHOT, unreadCount: 5 };

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
    const clearsSoFar = clearCalls;
    openSync();
    // Reported as not landed, because durably it did not: the correction below
    // takes it back out, and a producer that recorded it would dedupe its next
    // write away against a snapshot no longer there.
    await expect(synced).resolves.toBe(false);
    expect(readWidgetSnapshotAssistantId()).toBeNull();

    // The orphan comes off the Home Screen with the write itself rather than
    // waiting for whatever uses this module next, which on a session that is
    // ending may be nothing at all.
    await flush();
    expect(clearCalls).toBe(clearsSoFar + 1);
    // And that correction discharges the obligation it recorded, so nothing is
    // owed once it lands.
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
    const clearsSoFar = clearCalls;
    openSync();
    await expect(synced).resolves.toBe(false);
    expect(readWidgetSnapshotAssistantId()).toBeNull();

    await flush();
    // The write reached the plugin before the clear did and answered after it,
    // and the correction follows both.
    expect(bridgeOrder).toEqual(["sync", "clear", "clear"]);
    expect(clearCalls).toBe(clearsSoFar + 1);
    await retryPendingWidgetSnapshotClear();
    expect(clearCalls).toBe(clearsSoFar + 1);
  });

  it("keeps owing a clear when the write's own correction cannot land", async () => {
    // The correction is best-effort like every other clear here, so the marker
    // is what makes the orphan's removal at-least-once when a bridge that is
    // failing takes the correction down with it.
    let openSync = (): void => {};
    syncGate = new Promise<void>((resolve) => {
      openSync = resolve;
    });
    const synced = syncWidgetSnapshot(SNAPSHOT, "asst-1");
    await flush();

    await expect(clearWidgetSnapshot()).resolves.toBe(true);
    clearRejects = true;
    openSync();
    await expect(synced).resolves.toBe(false);
    await flush();

    clearRejects = false;
    const clearsSoFar = clearCalls;
    await expect(retryPendingWidgetSnapshotClear()).resolves.toBe(true);
    expect(clearCalls).toBe(clearsSoFar + 1);
  });

  it("holds the next session's first write behind a correction in flight", async () => {
    // The correction is a clear like any other, so what the next session writes
    // has to wait on it rather than race it: one fired outside the module's
    // bookkeeping is either overtaken by that write and wipes it, or moves the
    // counter under it and reads as a clear racing it, and either way the
    // widgets stay empty until the conversation data changes or the heartbeat
    // comes round a quarter of an hour later.
    let openSync = (): void => {};
    syncGate = new Promise<void>((resolve) => {
      openSync = resolve;
    });
    const firstWrite = syncWidgetSnapshot(SNAPSHOT, "asst-1");
    await flush();

    await expect(clearWidgetSnapshot()).resolves.toBe(true);

    let openCorrection = (): void => {};
    clearGate = new Promise<void>((resolve) => {
      openCorrection = resolve;
    });
    syncGate = null;
    openSync();
    await expect(firstWrite).resolves.toBe(false);
    await flush();

    const secondWrite = syncWidgetSnapshot(NEWER_SNAPSHOT, "asst-2");
    await flush();
    // Nothing of the new session's is on the bridge while the correction is
    // open, so the correction cannot land on top of it.
    expect(bridgeOrder).toEqual(["sync", "clear", "clear"]);

    openCorrection();
    await expect(secondWrite).resolves.toBe(true);
    expect(bridgeOrder).toEqual(["sync", "clear", "clear", "sync"]);
    expect(syncCalls).toEqual([SNAPSHOT, NEWER_SNAPSHOT]);
    expect(readWidgetSnapshotAssistantId()).toBe("asst-2");

    // The correction discharged the obligation it was fired for, and the write
    // that followed it is left alone.
    await expect(retryPendingWidgetSnapshotClear()).resolves.toBe(true);
    expect(clearCalls).toBe(2);
  });

  it("serializes a next-session write entered in the correction's own tick", async () => {
    // The correction is registered as part of the contested write's own turn,
    // so a write entered right behind it finds it rather than starting a second
    // clear beside it.
    let openSync = (): void => {};
    syncGate = new Promise<void>((resolve) => {
      openSync = resolve;
    });
    const firstWrite = syncWidgetSnapshot(SNAPSHOT, "asst-1");
    await flush();

    await expect(clearWidgetSnapshot()).resolves.toBe(true);

    let openCorrection = (): void => {};
    clearGate = new Promise<void>((resolve) => {
      openCorrection = resolve;
    });
    syncGate = null;
    openSync();
    await expect(firstWrite).resolves.toBe(false);

    const secondWrite = syncWidgetSnapshot(NEWER_SNAPSHOT, "asst-2");
    await flush();
    expect(bridgeOrder).toEqual(["sync", "clear", "clear"]);

    openCorrection();
    await expect(secondWrite).resolves.toBe(true);
    expect(bridgeOrder).toEqual(["sync", "clear", "clear", "sync"]);
    expect(readWidgetSnapshotAssistantId()).toBe("asst-2");
    expect(clearCalls).toBe(2);
  });

  it("is discharged by the next session's write when the correction failed", async () => {
    // A correction that cannot land leaves the obligation standing, and the
    // next write honors it on entry and then discharges it by landing: the
    // plugin replaces the App Group record, so nothing of the orphan survives.
    let openSync = (): void => {};
    syncGate = new Promise<void>((resolve) => {
      openSync = resolve;
    });
    const firstWrite = syncWidgetSnapshot(SNAPSHOT, "asst-1");
    await flush();

    await expect(clearWidgetSnapshot()).resolves.toBe(true);
    clearRejects = true;
    syncGate = null;
    openSync();
    await expect(firstWrite).resolves.toBe(false);
    await flush();

    const clearsSoFar = clearCalls;
    await expect(syncWidgetSnapshot(NEWER_SNAPSHOT, "asst-2")).resolves.toBe(
      true,
    );
    expect(clearCalls).toBe(clearsSoFar + 1);
    expect(readWidgetSnapshotAssistantId()).toBe("asst-2");

    clearRejects = false;
    await expect(retryPendingWidgetSnapshotClear()).resolves.toBe(true);
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

describe("a write the session it describes outlived", () => {
  it("never reaches the plugin when a clear settles while it waits", async () => {
    // The finding this guards: sign-out's clear is already on the bridge as the
    // write is entered, and settles while the write waits on the owed clear it
    // honors first. A write that read the generation after that wait would take
    // the reading the clear had already moved and put the departed account's
    // rows back in the App Group. Read on entry, the clear's start bump is
    // included and its settle bump carries the counter past what the write
    // expects, so the payload never goes on the bridge at all.
    let openSignOutClear = (): void => {};
    clearGate = new Promise<void>((resolve) => {
      openSignOutClear = resolve;
    });
    const cleared = clearWidgetSnapshot();

    let openOwedClear = (): void => {};
    clearGate = new Promise<void>((resolve) => {
      openOwedClear = resolve;
    });
    const synced = syncWidgetSnapshot(SNAPSHOT, "asst-1");
    await flush();

    openSignOutClear();
    await expect(cleared).resolves.toBe(true);
    openOwedClear();
    await expect(synced).resolves.toBe(false);

    expect(syncCalls).toHaveLength(0);
    expect(bridgeOrder).toEqual(["clear", "clear"]);
    expect(readWidgetSnapshotAssistantId()).toBeNull();
  });

  it("never reaches the plugin for a caller retired while it waits", async () => {
    // The other half of that window, and the one no generation can see: the
    // clear is done and the producer hook unmounted under this write, which
    // reports it through the liveness callback it passed.
    clearRejects = true;
    await expect(clearWidgetSnapshot()).resolves.toBe(false);
    clearRejects = false;

    let openOwedClear = (): void => {};
    clearGate = new Promise<void>((resolve) => {
      openOwedClear = resolve;
    });
    let retired = false;
    const synced = syncWidgetSnapshot(SNAPSHOT, "asst-1", () => retired);
    await flush();

    retired = true;
    openOwedClear();
    await expect(synced).resolves.toBe(false);
    expect(syncCalls).toHaveLength(0);
  });

  it("clears what it wrote when a clear ran across it on the bridge", async () => {
    // Past the wait there is nothing left to hold back, so the correction is
    // the write's own: a clear moved the generation under it, meaning what
    // landed belongs to a session that is over, and the Home Screen it reaches
    // never reloads on its own. The retirement that comes with a sign-out is
    // along for the ride here; the clear is what decides.
    await syncWidgetSnapshot(SNAPSHOT, "asst-1");
    expect(readWidgetSnapshotAssistantId()).toBe("asst-1");

    let openSync = (): void => {};
    syncGate = new Promise<void>((resolve) => {
      openSync = resolve;
    });
    let retired = false;
    const synced = syncWidgetSnapshot(SNAPSHOT, "asst-1", () => retired);
    await flush();
    expect(syncCalls).toHaveLength(2);

    retired = true;
    await expect(clearWidgetSnapshot()).resolves.toBe(true);
    openSync();
    await expect(synced).resolves.toBe(false);
    await flush();

    expect(bridgeOrder).toEqual(["sync", "sync", "clear", "clear"]);
    expect(clearCalls).toBe(2);
    expect(readWidgetSnapshotAssistantId()).toBeNull();
  });

  it("lands silently when a newer write superseded it on the bridge", async () => {
    // Two writes from one producer overlap, and the hook retires the older as
    // it fires the newer. Retirement alone says only that a successor is on its
    // way, and the successor overwrites what this one leaves, so there is
    // nothing here to correct.
    //
    // Correcting it anyway is the bug this guards: that clear moves the
    // generation, the NEWER write then reads itself as contested and corrects
    // in turn, and the snapshot the session actually wants is wiped while the
    // producer records it as landed, pinning empty widgets until the heartbeat.
    let openFirst = (): void => {};
    syncGate = new Promise<void>((resolve) => {
      openFirst = resolve;
    });
    let superseded = false;
    const first = syncWidgetSnapshot(SNAPSHOT, "asst-1", () => superseded);
    await flush();

    let openSecond = (): void => {};
    syncGate = new Promise<void>((resolve) => {
      openSecond = resolve;
    });
    superseded = true;
    const second = syncWidgetSnapshot(NEWER_SNAPSHOT, "asst-1", () => false);
    await flush();

    openFirst();
    await expect(first).resolves.toBe(true);
    await flush();

    openSecond();
    await expect(second).resolves.toBe(true);
    await flush();

    expect(syncCalls).toEqual([SNAPSHOT, NEWER_SNAPSHOT]);
    expect(bridgeOrder).toEqual(["sync", "sync"]);
    expect(clearCalls).toBe(0);
    expect(readWidgetSnapshotAssistantId()).toBe("asst-1");
  });

  it("keeps what it wrote when its caller merely unmounted", async () => {
    // The app closing or the layout swapping out retires the attempt without
    // ending the session, and the snapshot is exactly what should stay on the
    // Home Screen then: nothing was signed out of, so there is nothing to take
    // back. A correction here would empty the widgets every time the app was
    // closed with a write in flight.
    let openSync = (): void => {};
    syncGate = new Promise<void>((resolve) => {
      openSync = resolve;
    });
    let retired = false;
    const synced = syncWidgetSnapshot(SNAPSHOT, "asst-1", () => retired);
    await flush();

    retired = true;
    openSync();
    await expect(synced).resolves.toBe(true);
    await flush();

    expect(bridgeOrder).toEqual(["sync"]);
    expect(clearCalls).toBe(0);
    // And it is recorded as the App Group's content, which is what it is: the
    // next cold launch has to be able to tell whose snapshot it inherited.
    expect(readWidgetSnapshotAssistantId()).toBe("asst-1");

    // Nothing is owed either, so no later use of the module drops it.
    await expect(retryPendingWidgetSnapshotClear()).resolves.toBe(true);
    expect(clearCalls).toBe(0);
  });

  it("still writes when it joins a retry a mount already started", async () => {
    // The producer hook retries an owed clear on mount and fires its first sync
    // in the same commit, so a write routinely awaits a clear that started
    // before it did. That clear moves the counter exactly as one racing the
    // write would, and only the anchor the retry reports tells the two apart.
    clearRejects = true;
    await expect(clearWidgetSnapshot()).resolves.toBe(false);
    clearRejects = false;

    let openOwedClear = (): void => {};
    clearGate = new Promise<void>((resolve) => {
      openOwedClear = resolve;
    });
    const retried = retryPendingWidgetSnapshotClear();
    await flush();

    const synced = syncWidgetSnapshot(SNAPSHOT, "asst-1");
    await flush();
    openOwedClear();

    await expect(retried).resolves.toBe(true);
    await expect(synced).resolves.toBe(true);
    expect(bridgeOrder).toEqual(["clear", "clear", "sync"]);
    expect(readWidgetSnapshotAssistantId()).toBe("asst-1");
  });

  it("writes normally while its caller is still live", async () => {
    await expect(
      syncWidgetSnapshot(SNAPSHOT, "asst-1", () => false),
    ).resolves.toBe(true);
    expect(syncCalls).toEqual([SNAPSHOT]);
    expect(clearCalls).toBe(0);
    expect(readWidgetSnapshotAssistantId()).toBe("asst-1");

    // Nothing owed, so nothing corrects the write afterwards either.
    await expect(retryPendingWidgetSnapshotClear()).resolves.toBe(true);
    expect(clearCalls).toBe(0);
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
