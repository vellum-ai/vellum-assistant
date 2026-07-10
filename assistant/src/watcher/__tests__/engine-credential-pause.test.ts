/**
 * Tests for the durable `credentialPausedAt` marker that backs the watcher
 * engine's auth-reconnect notifications (engine-auth-notify.test.ts covers the
 * in-process once-per-episode semantics with a non-persisting store).
 *
 * Here the fake store persists `credentialPausedAt` across ticks like the real
 * one, so these assert the persistence layer: the marker is stamped on the
 * credential skip gate and on auth-shaped poll errors, it survives a simulated
 * restart to suppress re-notification for an ongoing outage, it collapses
 * sibling watchers on one dead account to a single notification, and it clears
 * on recovery so a later outage notifies again.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

interface FakeWatcher {
  id: string;
  name: string;
  providerId: string;
  enabled: boolean;
  pollIntervalMs: number;
  actionPrompt: string;
  watermark: string | null;
  conversationId: string | null;
  status: string;
  consecutiveErrors: number;
  lastError: string | null;
  credentialPausedAt: number | null;
  lastPollAt: number | null;
  nextPollAt: number;
  configJson: string | null;
  credentialService: string;
  createdAt: number;
  updatedAt: number;
}

let fakeWatchers: FakeWatcher[] = [];
const skipCalls: string[] = [];

function findWatcher(id: string): FakeWatcher | undefined {
  return fakeWatchers.find((w) => w.id === id);
}

// Overridable so a test can claim a subset of fakeWatchers (a sibling not
// yet due) while hasCredentialPause still sees every persisted row.
let claimDueWatchersImpl: () => FakeWatcher[] = () =>
  fakeWatchers.map((w) => ({ ...w }));

// A store fake that persists credentialPausedAt exactly like the real store:
// stamped (coalesced) on skip and on auth-shaped fail, cleared on success.
mock.module("../watcher-store.js", () => ({
  claimDueWatchers: () => claimDueWatchersImpl(),
  completeWatcherPoll: (id: string) => {
    const w = findWatcher(id);
    if (w) {
      w.consecutiveErrors = 0;
      w.credentialPausedAt = null;
    }
  },
  failWatcherPoll: (
    id: string,
    _error: string,
    opts?: { credentialPaused?: boolean },
  ) => {
    const w = findWatcher(id);
    if (w) {
      w.consecutiveErrors += 1;
      if (opts?.credentialPaused) {
        w.credentialPausedAt = w.credentialPausedAt ?? Date.now();
      }
    }
  },
  skipWatcherPoll: (id: string) => {
    skipCalls.push(id);
    const w = findWatcher(id);
    if (w) {
      w.credentialPausedAt = w.credentialPausedAt ?? Date.now();
    }
  },
  hasCredentialPause: (credentialService: string) =>
    fakeWatchers.some(
      (w) =>
        w.credentialService === credentialService &&
        w.enabled &&
        w.credentialPausedAt !== null,
    ),
  disableWatcher: (id: string) => {
    fakeWatchers = fakeWatchers.filter((w) => w.id !== id);
  },
  insertWatcherEvent: () => true,
  getPendingEvents: () => [],
  resetStuckWatchers: () => 0,
  setWatcherConversationId: () => {},
  updateEventDisposition: () => {},
}));

mock.module("../provider-registry.js", () => ({
  getWatcherProvider: () => ({
    fetchNew: () => providerFetchImpl(),
    getInitialWatermark: async () => "wm",
  }),
}));

mock.module("../../sequence/reply-matcher.js", () => ({
  checkForSequenceReplies: () => [],
}));

let credentialHealthImpl: () => Promise<{
  status: string;
  details: string;
  canAutoRecover: boolean;
} | null> = async () => null;
let providerFetchImpl: () => Promise<{
  items: Array<Record<string, unknown>>;
  watermark: string;
}> = async () => ({ items: [], watermark: "wm" });

mock.module("../../credential-health/credential-health-service.js", () => ({
  checkCredentialForProvider: () => credentialHealthImpl(),
}));

mock.module("../../runtime/background-job-runner.js", () => ({
  runBackgroundJob: async () => ({ conversationId: "conv-stub", ok: true }),
}));

mock.module("../telemetry.js", () => ({
  recordWatcherInventoryIfDue: () => {},
  recordWatcherLlmProcessed: () => {},
}));

const { runWatchersOnce, _resetAuthNotificationStateForTests } =
  await import("../engine.js");

function makeWatcher(overrides: Partial<FakeWatcher> = {}): FakeWatcher {
  const now = Date.now();
  return {
    id: "watcher-1",
    name: "Work Outlook",
    providerId: "outlook",
    enabled: true,
    pollIntervalMs: 60_000,
    actionPrompt: "Summarize new mail.",
    watermark: "wm",
    conversationId: null,
    status: "polling",
    consecutiveErrors: 0,
    lastError: null,
    credentialPausedAt: null,
    lastPollAt: now,
    nextPollAt: now + 60_000,
    configJson: null,
    credentialService: "outlook",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const revoked = {
  status: "revoked",
  details: "outlook token was rejected (401/403). Re-authorization required.",
  canAutoRecover: false,
};

const authError = new Error(
  'No active OAuth connection found for "outlook". The outlook service needs to be reconnected.',
);

type Notification = { title: string; body: string };
function reconnects(all: Notification[]): Notification[] {
  return all.filter((n) => n.title.startsWith("Reconnect needed:"));
}

beforeEach(() => {
  fakeWatchers = [];
  skipCalls.length = 0;
  claimDueWatchersImpl = () => fakeWatchers.map((w) => ({ ...w }));
  credentialHealthImpl = async () => null;
  providerFetchImpl = async () => ({ items: [], watermark: "wm" });
  _resetAuthNotificationStateForTests();
});

describe("runWatchersOnce — durable credential-pause marker", () => {
  test("stamps the marker and notifies once on the first credential skip", async () => {
    fakeWatchers = [makeWatcher()];
    credentialHealthImpl = async () => revoked;
    const notes: Notification[] = [];

    await runWatchersOnce((n) => notes.push(n));

    expect(skipCalls).toEqual(["watcher-1"]);
    expect(reconnects(notes)).toHaveLength(1);
    expect(fakeWatchers[0].credentialPausedAt).not.toBeNull();
  });

  test("a restart mid-outage does not re-notify (durable marker suppresses a fresh process)", async () => {
    // credentialPausedAt already set simulates a watcher paused before the
    // restart; the in-process episode tracker was cleared in beforeEach.
    fakeWatchers = [makeWatcher({ credentialPausedAt: 1_000 })];
    credentialHealthImpl = async () => revoked;
    const notes: Notification[] = [];

    await runWatchersOnce((n) => notes.push(n));

    expect(skipCalls).toEqual(["watcher-1"]);
    expect(reconnects(notes)).toHaveLength(0);
  });

  test("after a restart, an unstamped sibling on an already-stamped account does not re-notify", async () => {
    // Watcher A was stamped before the restart; sibling B on the same
    // account was never due, so its own row is unstamped. The dedup read is
    // credential-scoped, so A's persisted marker must suppress B's
    // notification even though the in-process tracker is empty.
    const watcherA = makeWatcher({
      id: "watcher-a",
      name: "Outlook Mail",
      credentialPausedAt: 1_000,
      // A is backing off after its earlier skip; only B is due this tick.
      nextPollAt: Date.now() + 3_600_000,
    });
    const watcherB = makeWatcher({
      id: "watcher-b",
      name: "Outlook Calendar",
      credentialPausedAt: null,
    });
    fakeWatchers = [watcherA, watcherB];
    // Only B is claimed this tick (A is not yet due).
    const claimable = [watcherB];
    claimDueWatchersImpl = () => claimable.map((w) => ({ ...w }));
    credentialHealthImpl = async () => revoked;
    const notes: Notification[] = [];

    await runWatchersOnce((n) => notes.push(n));

    // B is paused but the user is not told again for the same outage.
    expect(skipCalls).toEqual(["watcher-b"]);
    expect(reconnects(notes)).toHaveLength(0);
    expect(watcherB.credentialPausedAt).not.toBeNull();

    // Full recovery: both rows clear their markers.
    credentialHealthImpl = async () => null;
    claimDueWatchersImpl = () => fakeWatchers.map((w) => ({ ...w }));
    await runWatchersOnce((n) => notes.push(n));
    expect(watcherA.credentialPausedAt).toBeNull();
    expect(watcherB.credentialPausedAt).toBeNull();

    // A genuinely new outage notifies afresh.
    credentialHealthImpl = async () => revoked;
    await runWatchersOnce((n) => notes.push(n));
    expect(reconnects(notes)).toHaveLength(1);
  });

  test("collapses sibling watchers on one dead account to a single notification", async () => {
    fakeWatchers = [
      makeWatcher({ id: "watcher-1", name: "Outlook Mail" }),
      makeWatcher({ id: "watcher-2", name: "Outlook Calendar" }),
    ];
    credentialHealthImpl = async () => revoked;
    const notes: Notification[] = [];

    await runWatchersOnce((n) => notes.push(n));

    expect(skipCalls.sort()).toEqual(["watcher-1", "watcher-2"]);
    expect(reconnects(notes)).toHaveLength(1);
    // Both watchers surface as paused regardless of which one notified.
    expect(fakeWatchers[0].credentialPausedAt).not.toBeNull();
    expect(fakeWatchers[1].credentialPausedAt).not.toBeNull();
  });

  test("marker clears on recovery so a later outage notifies again", async () => {
    fakeWatchers = [makeWatcher()];
    const notes: Notification[] = [];

    credentialHealthImpl = async () => revoked;
    await runWatchersOnce((n) => notes.push(n));
    expect(reconnects(notes)).toHaveLength(1);
    expect(fakeWatchers[0].credentialPausedAt).not.toBeNull();

    // Recovery: credential healthy, poll succeeds → marker cleared.
    credentialHealthImpl = async () => null;
    await runWatchersOnce((n) => notes.push(n));
    expect(fakeWatchers[0].credentialPausedAt).toBeNull();

    // Second outage → fresh notification.
    credentialHealthImpl = async () => revoked;
    await runWatchersOnce((n) => notes.push(n));
    expect(reconnects(notes)).toHaveLength(2);
  });

  test("an auth-shaped poll error stamps the marker for list surfacing", async () => {
    fakeWatchers = [makeWatcher()];
    // Health gate passes, but the poll itself fails with an auth-shaped error.
    credentialHealthImpl = async () => null;
    providerFetchImpl = async () => {
      throw authError;
    };
    const notes: Notification[] = [];

    await runWatchersOnce((n) => notes.push(n));

    expect(reconnects(notes)).toHaveLength(1);
    expect(fakeWatchers[0].credentialPausedAt).not.toBeNull();
  });

  test("a non-auth poll error leaves the marker untouched", async () => {
    fakeWatchers = [makeWatcher()];
    credentialHealthImpl = async () => null;
    providerFetchImpl = async () => {
      throw new Error("network timeout (ETIMEDOUT)");
    };
    const notes: Notification[] = [];

    await runWatchersOnce((n) => notes.push(n));

    expect(reconnects(notes)).toHaveLength(0);
    expect(fakeWatchers[0].credentialPausedAt).toBeNull();
  });
});
