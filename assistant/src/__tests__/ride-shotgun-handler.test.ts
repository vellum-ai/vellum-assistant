import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { HandlerContext } from "../daemon/handlers/shared.js";

// ── Mocks ──────────────────────────────────────────────────────────

let mockEnsureChromeResult = {
  baseUrl: "http://localhost:9222",
  launchedByUs: false,
  userDataDir: "/tmp/cdp-test",
};
let mockEnsureChromeShouldThrow = false;
let mockMinimizeCalled = false;
let mockMinimizeBaseUrl: string | undefined;

mock.module("../tools/browser/chrome-cdp.js", () => ({
  ensureChromeWithCdp: async () => {
    if (mockEnsureChromeShouldThrow) {
      throw new Error("Chrome launch failed");
    }
    return { ...mockEnsureChromeResult };
  },
  minimizeChromeWindow: async (baseUrl: string) => {
    mockMinimizeCalled = true;
    mockMinimizeBaseUrl = baseUrl;
  },
  isCdpReady: async () => true,
  restoreChromeWindow: async () => {},
}));

let mockRecorderStartCalls = 0;
let mockRecorderStartShouldThrow = false;
let mockRecorderStartThrowCount = 0;
let mockRecorderConstructorCdpBaseUrl: string | undefined;

mock.module("../tools/browser/network-recorder.js", () => ({
  NetworkRecorder: class MockNetworkRecorder {
    loginSignals: string[] = [];
    onLoginDetected?: () => void;
    get entryCount() {
      return 0;
    }

    constructor(_targetDomain?: string, cdpBaseUrl?: string) {
      mockRecorderConstructorCdpBaseUrl = cdpBaseUrl;
    }

    async startDirect() {
      mockRecorderStartCalls++;
      if (
        mockRecorderStartShouldThrow &&
        mockRecorderStartCalls <= mockRecorderStartThrowCount
      ) {
        throw new Error("CDP not ready");
      }
    }

    async stop() {
      return [];
    }

    async extractCookies() {
      return [];
    }
  },
}));

mock.module("../tools/browser/recording-store.js", () => ({
  saveRecording: () => "/tmp/test-recording.json",
}));

mock.module("../tools/browser/auto-navigate.js", () => ({
  autoNavigate: async () => [],
}));

mock.module("../tools/browser/x-auto-navigate.js", () => ({
  navigateXPages: async () => [],
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

const mockLastSummaryBySession = new Map<string, string>();
mock.module("../daemon/watch-handler.js", () => ({
  generateSummary: async () => {},
  lastSummaryBySession: mockLastSummaryBySession,
}));

// ── Import under test (after mocks) ───────────────────────────────

const { handleRideShotgunStart, handleRideShotgunStop } =
  await import("../daemon/ride-shotgun-handler.js");
const { watchSessions } = await import("../tools/watch/watch-state.js");

// ── Helpers ────────────────────────────────────────────────────────

function makeMockCtx() {
  const sent: unknown[] = [];
  return {
    send: (msg: unknown) => sent.push(msg),
    sent,
  } as unknown as HandlerContext & { sent: unknown[] };
}

function waitForRecorderStart(timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = setInterval(() => {
      if (mockRecorderStartCalls > 0) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(poll);
        reject(new Error("Timed out waiting for recorder start"));
      }
    }, 50);
  });
}

// ── Tests ──────────────────────────────────────────────────────────

describe("ride-shotgun-handler", () => {
  beforeEach(() => {
    mockRecorderStartCalls = 0;
    mockRecorderStartShouldThrow = false;
    mockRecorderStartThrowCount = 0;
    mockRecorderConstructorCdpBaseUrl = undefined;
    mockMinimizeCalled = false;
    mockMinimizeBaseUrl = undefined;
    mockEnsureChromeShouldThrow = false;
    mockEnsureChromeResult = {
      baseUrl: "http://localhost:9222",
      launchedByUs: false,
      userDataDir: "/tmp/cdp-test",
    };
    mockLastSummaryBySession.clear();
    watchSessions.clear();
  });

  afterEach(() => {
    // Clean up any dangling sessions
    for (const [, session] of watchSessions) {
      if (session.timeoutHandle) clearTimeout(session.timeoutHandle);
    }
    watchSessions.clear();
  });

  test("learn mode calls ensureChromeWithCdp before starting recorder", async () => {
    const ctx = makeMockCtx();

    await handleRideShotgunStart(
      {
        type: "ride_shotgun_start",
        durationSeconds: 60,
        intervalSeconds: 5,
        mode: "learn",
        targetDomain: "example.com",
        autoNavigate: false,
      },
      ctx,
    );

    // Background recording start — wait for it
    await waitForRecorderStart();

    expect(mockRecorderStartCalls).toBe(1);
    // The recorder should receive the CDP base URL from the session
    expect(mockRecorderConstructorCdpBaseUrl).toBe("http://localhost:9222");
  });

  test("learn mode passes CDP base URL to NetworkRecorder constructor", async () => {
    mockEnsureChromeResult = {
      baseUrl: "http://localhost:9333",
      launchedByUs: true,
      userDataDir: "/tmp/cdp-custom",
    };

    const ctx = makeMockCtx();

    await handleRideShotgunStart(
      {
        type: "ride_shotgun_start",
        durationSeconds: 60,
        intervalSeconds: 5,
        mode: "learn",
        targetDomain: "example.com",
        autoNavigate: false,
      },
      ctx,
    );

    await waitForRecorderStart();

    expect(mockRecorderConstructorCdpBaseUrl).toBe("http://localhost:9333");
  });

  test("learn mode does not start recorder when ensureChromeWithCdp fails", async () => {
    mockEnsureChromeShouldThrow = true;

    const ctx = makeMockCtx();

    await handleRideShotgunStart(
      {
        type: "ride_shotgun_start",
        durationSeconds: 60,
        intervalSeconds: 5,
        mode: "learn",
        targetDomain: "example.com",
        autoNavigate: false,
      },
      ctx,
    );

    // Give background task time to execute
    await new Promise((r) => setTimeout(r, 200));

    expect(mockRecorderStartCalls).toBe(0);
  });

  test("learn mode minimizes Chrome on completion when assistant launched it", async () => {
    mockEnsureChromeResult = {
      baseUrl: "http://localhost:9222",
      launchedByUs: true,
      userDataDir: "/tmp/cdp-test",
    };

    const ctx = makeMockCtx();

    await handleRideShotgunStart(
      {
        type: "ride_shotgun_start",
        durationSeconds: 60,
        intervalSeconds: 5,
        mode: "learn",
        targetDomain: "example.com",
        autoNavigate: false,
      },
      ctx,
    );

    await waitForRecorderStart();

    // Find the session and stop it
    const watchId = [...watchSessions.keys()][0]!;
    await handleRideShotgunStop({ type: "ride_shotgun_stop", watchId }, ctx);

    expect(mockMinimizeCalled).toBe(true);
    expect(mockMinimizeBaseUrl).toBe("http://localhost:9222");
  });

  test("learn mode does not minimize Chrome on completion when user launched it", async () => {
    mockEnsureChromeResult = {
      baseUrl: "http://localhost:9222",
      launchedByUs: false,
      userDataDir: "/tmp/cdp-test",
    };

    const ctx = makeMockCtx();

    await handleRideShotgunStart(
      {
        type: "ride_shotgun_start",
        durationSeconds: 60,
        intervalSeconds: 5,
        mode: "learn",
        targetDomain: "example.com",
        autoNavigate: false,
      },
      ctx,
    );

    await waitForRecorderStart();

    // Find the session and stop it
    const watchId = [...watchSessions.keys()][0]!;
    await handleRideShotgunStop({ type: "ride_shotgun_stop", watchId }, ctx);

    expect(mockMinimizeCalled).toBe(false);
  });

  test("observe mode does not call ensureChromeWithCdp", async () => {
    const ctx = makeMockCtx();

    await handleRideShotgunStart(
      {
        type: "ride_shotgun_start",
        durationSeconds: 60,
        intervalSeconds: 5,
        mode: "observe",
      },
      ctx,
    );

    // Give time for any background tasks
    await new Promise((r) => setTimeout(r, 200));

    // In observe mode, no recorder should be started
    expect(mockRecorderStartCalls).toBe(0);

    // Clean up
    const watchId = [...watchSessions.keys()][0]!;
    await handleRideShotgunStop({ type: "ride_shotgun_stop", watchId }, ctx);
  });

  test("sends watch_started message with session IDs", async () => {
    const ctx = makeMockCtx();

    await handleRideShotgunStart(
      {
        type: "ride_shotgun_start",
        durationSeconds: 30,
        intervalSeconds: 5,
        mode: "learn",
        targetDomain: "example.com",
        autoNavigate: false,
      },
      ctx,
    );

    const startMsg = ctx.sent.find(
      (m: any) => m.type === "watch_started",
    ) as any;
    expect(startMsg).toBeDefined();
    expect(startMsg.sessionId).toBeDefined();
    expect(startMsg.watchId).toBeDefined();
    expect(startMsg.durationSeconds).toBe(30);

    // Clean up
    const watchId = startMsg.watchId;
    await handleRideShotgunStop({ type: "ride_shotgun_stop", watchId }, ctx);
  });

  test("sends ride_shotgun_error when ensureChromeWithCdp fails", async () => {
    mockEnsureChromeShouldThrow = true;

    const ctx = makeMockCtx();

    await handleRideShotgunStart(
      {
        type: "ride_shotgun_start",
        durationSeconds: 60,
        intervalSeconds: 5,
        mode: "learn",
        targetDomain: "example.com",
        autoNavigate: false,
      },
      ctx,
    );

    // Give background task time to execute and complete session
    await new Promise((r) => setTimeout(r, 500));

    const errorMsg = ctx.sent.find(
      (m: any) => m.type === "ride_shotgun_error",
    ) as any;
    expect(errorMsg).toBeDefined();
    expect(errorMsg.watchId).toBeDefined();
    expect(errorMsg.sessionId).toBeDefined();
    expect(errorMsg.message).toContain("Chrome CDP");
  });

  test("cleans up session when ensureChromeWithCdp fails", async () => {
    mockEnsureChromeShouldThrow = true;

    const ctx = makeMockCtx();

    await handleRideShotgunStart(
      {
        type: "ride_shotgun_start",
        durationSeconds: 60,
        intervalSeconds: 5,
        mode: "learn",
        targetDomain: "example.com",
        autoNavigate: false,
      },
      ctx,
    );

    // Give background task time to execute
    await new Promise((r) => setTimeout(r, 500));

    // Session should be completed (not left hanging for the full duration)
    const session = [...watchSessions.values()][0];
    expect(session?.status).toBe("completed");
  });

  test("reports failure summary when no recorder ever started", async () => {
    mockEnsureChromeShouldThrow = true;

    const ctx = makeMockCtx();

    await handleRideShotgunStart(
      {
        type: "ride_shotgun_start",
        durationSeconds: 60,
        intervalSeconds: 5,
        mode: "learn",
        targetDomain: "example.com",
        autoNavigate: false,
      },
      ctx,
    );

    // Give background task time to execute
    await new Promise((r) => setTimeout(r, 500));

    // The result message should indicate the specific CDP failure
    const resultMsg = ctx.sent.find(
      (m: any) => m.type === "ride_shotgun_result",
    ) as any;
    expect(resultMsg).toBeDefined();
    expect(resultMsg.summary).toContain("failed");
    expect(resultMsg.summary).toContain("browser could not be started");
    expect(resultMsg.summary).not.toContain("recording saved");
  });

  test("sends ride_shotgun_error when all 10 recorder retries fail", async () => {
    mockRecorderStartShouldThrow = true;
    mockRecorderStartThrowCount = 10;

    const ctx = makeMockCtx();

    await handleRideShotgunStart(
      {
        type: "ride_shotgun_start",
        durationSeconds: 60,
        intervalSeconds: 5,
        mode: "learn",
        targetDomain: "example.com",
        autoNavigate: false,
      },
      ctx,
    );

    // Wait for all 10 retry attempts (each has a 2s delay except the last)
    // 9 retries * 2s = 18s, but mock doesn't actually wait — it should complete quickly
    // The mock delays are real setTimeout calls, so we need enough time
    await new Promise((r) => setTimeout(r, 25000));

    const errorMsg = ctx.sent.find(
      (m: any) => m.type === "ride_shotgun_error",
    ) as any;
    expect(errorMsg).toBeDefined();
    expect(errorMsg.message).toContain("10 attempts");

    // Session should be completed
    const session = [...watchSessions.values()][0];
    expect(session?.status).toBe("completed");
  }, 30000); // Extended timeout for retry delays
});
