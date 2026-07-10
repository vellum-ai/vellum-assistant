/**
 * Tests for the watcher engine's auth-failure notification behavior.
 *
 * Covers the two paths that surface a broken account connection to the
 * user: the pre-poll credential-health skip gate and auth-shaped poll
 * failures in the catch block. Asserts once-per-episode semantics
 * (notify once while the problem persists; re-notify after a recovery).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks (controllable via mutable state) ─────────────────────

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
  lastPollAt: number | null;
  nextPollAt: number;
  configJson: string | null;
  credentialService: string;
  createdAt: number;
  updatedAt: number;
}

let fakeWatchers: FakeWatcher[] = [];
const skipCalls: Array<{ watcherId: string; reason: string }> = [];
const disableCalls: Array<{ watcherId: string; reason: string }> = [];
let completeShouldClearErrors = true;

mock.module("../watcher-store.js", () => ({
  // Return per-tick snapshot copies so the engine's circuit-breaker check
  // (`watcher.consecutiveErrors + 1`) reads the pre-poll stored count, as it
  // does in production where the claimed row is a DB snapshot.
  claimDueWatchers: () => fakeWatchers.map((w) => ({ ...w })),
  completeWatcherPoll: () => {
    // A real successful poll resets the consecutive-error counter.
    if (completeShouldClearErrors) {
      for (const w of fakeWatchers) {
        w.consecutiveErrors = 0;
      }
    }
  },
  failWatcherPoll: (watcherId: string) => {
    // Mirror the store's real behavior: bump the consecutive-error count so
    // the circuit breaker can trip across ticks.
    for (const w of fakeWatchers) {
      if (w.id === watcherId) {
        w.consecutiveErrors += 1;
      }
    }
  },
  skipWatcherPoll: (watcherId: string, reason: string) => {
    skipCalls.push({ watcherId, reason });
  },
  // This fake store does not persist credentialPausedAt, so the durable
  // credential-scoped marker never suppresses — this suite exercises the
  // in-process episode tracker alone (engine-credential-pause.test.ts covers
  // the durable layer).
  hasCredentialPause: () => false,
  disableWatcher: (watcherId: string, reason: string) => {
    disableCalls.push({ watcherId, reason });
    // A disabled watcher is no longer claimed on later ticks.
    fakeWatchers = fakeWatchers.filter((w) => w.id !== watcherId);
  },
  insertWatcherEvent: () => true,
  getPendingEvents: () => [],
  resetStuckWatchers: () => 0,
  setWatcherConversationId: () => {},
  updateEventDisposition: () => {},
}));

let providerFetchImpl: () => Promise<{
  items: Array<Record<string, unknown>>;
  watermark: string;
}> = async () => ({ items: [], watermark: "wm" });

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

// Import after mocks are in place.
const { runWatchersOnce, _resetAuthNotificationStateForTests } =
  await import("../engine.js");

// ── Fixtures ──────────────────────────────────────────────────────────

function makeWatcher(overrides: Partial<FakeWatcher> = {}): FakeWatcher {
  const now = Date.now();
  return {
    id: "watcher-1",
    name: "Outlook inbox",
    providerId: "outlook",
    enabled: true,
    pollIntervalMs: 60_000,
    actionPrompt: "Triage and respond.",
    watermark: "wm",
    conversationId: null,
    status: "polling",
    consecutiveErrors: 0,
    lastError: null,
    lastPollAt: now,
    nextPollAt: now + 60_000,
    configJson: null,
    credentialService: "outlook",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const authError = new Error(
  'No active OAuth connection found for "outlook". The outlook service needs to be connected before it can be used.',
);

type Notification = { title: string; body: string };

function reconnectNotifications(all: Notification[]): Notification[] {
  return all.filter((n) => n.title.startsWith("Reconnect needed:"));
}

function disableNotifications(all: Notification[]): Notification[] {
  return all.filter((n) => n.title.startsWith("Watcher disabled:"));
}

beforeEach(() => {
  fakeWatchers = [];
  skipCalls.length = 0;
  disableCalls.length = 0;
  completeShouldClearErrors = true;
  providerFetchImpl = async () => ({ items: [], watermark: "wm" });
  credentialHealthImpl = async () => null;
  _resetAuthNotificationStateForTests();
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("runWatchersOnce — auth-failure notifications", () => {
  test("auth-shaped poll failure notifies once across ticks, then disable notification mentions reconnect", async () => {
    fakeWatchers = [makeWatcher()];
    providerFetchImpl = async () => {
      throw authError;
    };

    const notifications: Notification[] = [];
    const notify = (n: Notification) => notifications.push(n);

    // Five consecutive failing ticks: reconnect notice fires once; the
    // circuit breaker trips on the fifth (consecutiveErrors 0→4).
    for (let i = 0; i < 5; i++) {
      await runWatchersOnce(notify);
    }

    const reconnects = reconnectNotifications(notifications);
    expect(reconnects).toHaveLength(1);
    expect(reconnects[0].body).toContain("outlook");
    expect(reconnects[0].body.toLowerCase()).toContain("reconnect");

    const disables = disableNotifications(notifications);
    expect(disables).toHaveLength(1);
    expect(disables[0].body.toLowerCase()).toContain("reconnect");
    expect(disables[0].body).toContain("outlook");
  });

  test("auth error → success → auth error again produces two reconnect notifications", async () => {
    fakeWatchers = [makeWatcher()];
    const notifications: Notification[] = [];
    const notify = (n: Notification) => notifications.push(n);

    // Tick 1: auth failure.
    providerFetchImpl = async () => {
      throw authError;
    };
    await runWatchersOnce(notify);

    // Tick 2: success (clears the episode).
    providerFetchImpl = async () => ({ items: [], watermark: "wm" });
    await runWatchersOnce(notify);

    // Tick 3: auth failure again (new episode).
    providerFetchImpl = async () => {
      throw authError;
    };
    await runWatchersOnce(notify);

    expect(reconnectNotifications(notifications)).toHaveLength(2);
  });

  test("alternating credential-health and auth-error paths notify only once per outage", async () => {
    fakeWatchers = [makeWatcher()];
    const notifications: Notification[] = [];
    const notify = (n: Notification) => notifications.push(n);

    // Tick 1: credential health reports the account revoked → skip gate
    // path raises the episode under "credential-unhealthy".
    credentialHealthImpl = async () => ({
      status: "revoked",
      details:
        "outlook token was rejected (401/403). Re-authorization required.",
      canAutoRecover: false,
    });
    await runWatchersOnce(notify);

    // Tick 2: the health check itself throws (so the skip gate is bypassed
    // and the poll proceeds), then the poll fails with an auth-shaped error
    // → catch-block path under a different status key ("auth-error").
    credentialHealthImpl = async () => {
      throw new Error("health check unavailable");
    };
    providerFetchImpl = async () => {
      throw authError;
    };
    await runWatchersOnce(notify);

    // The status key flipped between ticks, but suppression is per watcher
    // outage: exactly one reconnect notification total.
    expect(reconnectNotifications(notifications)).toHaveLength(1);
  });

  test("circuit-breaker disable clears the episode so a re-enabled watcher notifies again", async () => {
    fakeWatchers = [makeWatcher()];
    providerFetchImpl = async () => {
      throw authError;
    };

    const notifications: Notification[] = [];
    const notify = (n: Notification) => notifications.push(n);

    // Drive to the circuit-breaker disable (consecutiveErrors 0→4 over five
    // failing ticks). One reconnect notification fires; disable clears the
    // episode entry.
    for (let i = 0; i < 5; i++) {
      await runWatchersOnce(notify);
    }
    expect(reconnectNotifications(notifications)).toHaveLength(1);
    expect(disableNotifications(notifications)).toHaveLength(1);

    // Simulate the user re-enabling the still-broken watcher: it becomes
    // claimable again with a fresh error counter. Because disable cleared
    // the episode, the next auth failure raises a brand-new notification
    // rather than being suppressed by a stale entry.
    fakeWatchers = [makeWatcher()];
    await runWatchersOnce(notify);

    expect(reconnectNotifications(notifications)).toHaveLength(2);
  });

  test("non-auth poll failure does not produce a reconnect notification", async () => {
    fakeWatchers = [makeWatcher()];
    providerFetchImpl = async () => {
      throw new Error("network timeout (ETIMEDOUT)");
    };

    const notifications: Notification[] = [];
    const notify = (n: Notification) => notifications.push(n);

    await runWatchersOnce(notify);
    await runWatchersOnce(notify);
    await runWatchersOnce(notify);

    expect(reconnectNotifications(notifications)).toHaveLength(0);
  });

  test("credential-health skip gate notifies once per episode and skips the poll", async () => {
    fakeWatchers = [makeWatcher()];
    credentialHealthImpl = async () => ({
      status: "revoked",
      details:
        "outlook token was rejected (401/403). Re-authorization required.",
      canAutoRecover: false,
    });

    const notifications: Notification[] = [];
    const notify = (n: Notification) => notifications.push(n);

    await runWatchersOnce(notify);
    await runWatchersOnce(notify);
    await runWatchersOnce(notify);

    // Poll is skipped every tick, but the user is told exactly once.
    expect(skipCalls).toHaveLength(3);
    const reconnects = reconnectNotifications(notifications);
    expect(reconnects).toHaveLength(1);
    expect(reconnects[0].body).toContain("outlook");
    expect(reconnects[0].body.toLowerCase()).toContain("reconnect");
  });
});
