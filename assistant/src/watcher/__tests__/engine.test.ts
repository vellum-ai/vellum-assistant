/**
 * Tests for the watcher engine's Phase 2 (event processing) integration
 * with `runBackgroundJob`.
 *
 * Strategy: stub the watcher store, provider registry, sequence reply
 * matcher, and `runBackgroundJob` via `mock.module()` so we can drive
 * the engine without touching the DB or LLM, then assert the runner is
 * invoked with the expected options shape.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks ──────────────────────────────────────────────────────

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

interface FakeEvent {
  id: string;
  watcherId: string;
  externalId: string;
  eventType: string;
  summary: string;
  payloadJson: string;
  disposition: string;
  llmAction: string | null;
  processedAt: number | null;
  createdAt: number;
}

let fakeWatchers: FakeWatcher[] = [];
let fakePending: FakeEvent[] = [];
const setConvCalls: Array<{ watcherId: string; conversationId: string }> = [];
const dispositionCalls: Array<{
  eventId: string;
  disposition: string;
  reason: string;
}> = [];

mock.module("../watcher-store.js", () => ({
  claimDueWatchers: () => fakeWatchers,
  completeWatcherPoll: () => {},
  failWatcherPoll: () => {},
  skipWatcherPoll: () => {},
  disableWatcher: () => {},
  insertWatcherEvent: () => true,
  getPendingEvents: () => fakePending,
  resetStuckWatchers: () => 0,
  setWatcherConversationId: (watcherId: string, conversationId: string) => {
    setConvCalls.push({ watcherId, conversationId });
  },
  updateEventDisposition: (
    eventId: string,
    disposition: string,
    reason: string,
  ) => {
    dispositionCalls.push({ eventId, disposition, reason });
  },
}));

mock.module("../provider-registry.js", () => ({
  getWatcherProvider: () => ({
    fetchNew: async () => ({ items: [], watermark: "wm" }),
    getInitialWatermark: async () => "wm",
  }),
}));

mock.module("../../sequence/reply-matcher.js", () => ({
  checkForSequenceReplies: () => [],
}));

mock.module("../../credential-health/credential-health-service.js", () => ({
  checkCredentialForProvider: async () => null,
}));

const runJobCalls: Array<Record<string, unknown>> = [];
let runJobImpl: () => Promise<{
  conversationId: string;
  ok: boolean;
  error?: Error;
  errorKind?: string;
}> = async () => ({ conversationId: "conv-stub", ok: true });

mock.module("../../runtime/background-job-runner.js", () => ({
  runBackgroundJob: (opts: Record<string, unknown>) => {
    runJobCalls.push(opts);
    return runJobImpl();
  },
}));

// Import after mocks are in place.
const { runWatchersOnce } = await import("../engine.js");

// ── Fixtures ──────────────────────────────────────────────────────────

function makeWatcher(overrides: Partial<FakeWatcher> = {}): FakeWatcher {
  const now = Date.now();
  return {
    id: "watcher-1",
    name: "Linear inbox",
    providerId: "linear",
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
    credentialService: "linear",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<FakeEvent> = {}): FakeEvent {
  return {
    id: "evt-1",
    watcherId: "watcher-1",
    externalId: "ext-1",
    eventType: "issue_created",
    summary: "Investigate flaky CI",
    payloadJson: '{"title":"Investigate flaky CI"}',
    disposition: "pending",
    llmAction: null,
    processedAt: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  fakeWatchers = [];
  fakePending = [];
  setConvCalls.length = 0;
  dispositionCalls.length = 0;
  runJobCalls.length = 0;
  runJobImpl = async () => ({ conversationId: "conv-stub", ok: true });
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("runWatchersOnce — Phase 2 runBackgroundJob integration", () => {
  test("invokes runBackgroundJob with the expected options when pending events exist", async () => {
    fakeWatchers = [makeWatcher()];
    fakePending = [makeEvent()];

    const processed = await runWatchersOnce(
      () => {},
      () => {},
    );

    expect(processed).toBe(2); // 1 from poll phase + 1 from process phase
    expect(runJobCalls).toHaveLength(1);
    const opts = runJobCalls[0];
    expect(opts.jobName).toBe("watcher:watcher-1");
    expect(opts.source).toBe("watcher");
    expect(opts.origin).toBe("watcher");
    expect(opts.callSite).toBe("mainAgent");
    expect(opts.timeoutMs).toBe(15 * 60 * 1000);
    expect(opts.trustContext).toEqual({
      sourceChannel: "vellum",
      trustClass: "guardian",
    });
    expect(typeof opts.prompt).toBe("string");
    const prompt = opts.prompt as string;
    expect(prompt).toContain("Watcher: Linear inbox");
    expect(prompt).toContain("Investigate flaky CI");
    expect(prompt).toContain("Action prompt:");
    expect(prompt).toContain("Triage and respond.");
    expect(prompt).toContain("<watcher-disposition>");
  });

  test("on success: persists conversation id and marks events silent", async () => {
    fakeWatchers = [makeWatcher()];
    fakePending = [makeEvent({ id: "evt-1" }), makeEvent({ id: "evt-2" })];
    runJobImpl = async () => ({ conversationId: "conv-success", ok: true });

    await runWatchersOnce(
      () => {},
      () => {},
    );

    expect(setConvCalls).toEqual([
      { watcherId: "watcher-1", conversationId: "conv-success" },
    ]);
    expect(dispositionCalls).toHaveLength(2);
    for (const call of dispositionCalls) {
      expect(call.disposition).toBe("silent");
      expect(call.reason).toBe("Processed by LLM");
    }
  });

  test("on failure: persists conversation id and marks events with error reason", async () => {
    fakeWatchers = [makeWatcher()];
    fakePending = [makeEvent()];
    runJobImpl = async () => ({
      conversationId: "conv-fail",
      ok: false,
      error: new Error("model exploded"),
      errorKind: "exception",
    });

    await runWatchersOnce(
      () => {},
      () => {},
    );

    expect(setConvCalls).toEqual([
      { watcherId: "watcher-1", conversationId: "conv-fail" },
    ]);
    expect(dispositionCalls).toHaveLength(1);
    expect(dispositionCalls[0].disposition).toBe("error");
    expect(dispositionCalls[0].reason).toBe("model exploded");
  });

  test("skips runBackgroundJob entirely when no pending events", async () => {
    fakeWatchers = [makeWatcher()];
    fakePending = [];

    await runWatchersOnce(
      () => {},
      () => {},
    );

    expect(runJobCalls).toHaveLength(0);
    expect(setConvCalls).toHaveLength(0);
  });
});
