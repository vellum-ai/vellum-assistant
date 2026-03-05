import type * as net from "node:net";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { HandlerContext } from "../daemon/handlers.js";

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

mock.module("../daemon/watch-handler.js", () => ({
  generateSummary: async () => {},
  lastSummaryBySession: new Map<string, string>(),
}));

// ── Import under test (after mocks) ───────────────────────────────

const { handleRideShotgunStart, handleRideShotgunStop } =
  await import("../daemon/ride-shotgun-handler.js");
const { watchSessions } = await import("../tools/watch/watch-state.js");

// ── Helpers ────────────────────────────────────────────────────────

function makeMockSocket(): net.Socket {
  return { destroyed: false } as unknown as net.Socket;
}

function makeMockCtx() {
  const sent: unknown[] = [];
  return {
    send: (_socket: net.Socket, msg: unknown) => sent.push(msg),
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
    const socket = makeMockSocket();
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
      socket,
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

    const socket = makeMockSocket();
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
      socket,
      ctx,
    );

    await waitForRecorderStart();

    expect(mockRecorderConstructorCdpBaseUrl).toBe("http://localhost:9333");
  });

  test("learn mode does not start recorder when ensureChromeWithCdp fails", async () => {
    mockEnsureChromeShouldThrow = true;

    const socket = makeMockSocket();
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
      socket,
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

    const socket = makeMockSocket();
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
      socket,
      ctx,
    );

    await waitForRecorderStart();

    // Find the session and stop it
    const watchId = [...watchSessions.keys()][0]!;
    await handleRideShotgunStop(
      { type: "ride_shotgun_stop", watchId },
      socket,
      ctx,
    );

    expect(mockMinimizeCalled).toBe(true);
    expect(mockMinimizeBaseUrl).toBe("http://localhost:9222");
  });

  test("learn mode does not minimize Chrome on completion when user launched it", async () => {
    mockEnsureChromeResult = {
      baseUrl: "http://localhost:9222",
      launchedByUs: false,
      userDataDir: "/tmp/cdp-test",
    };

    const socket = makeMockSocket();
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
      socket,
      ctx,
    );

    await waitForRecorderStart();

    // Find the session and stop it
    const watchId = [...watchSessions.keys()][0]!;
    await handleRideShotgunStop(
      { type: "ride_shotgun_stop", watchId },
      socket,
      ctx,
    );

    expect(mockMinimizeCalled).toBe(false);
  });

  test("observe mode does not call ensureChromeWithCdp", async () => {
    const socket = makeMockSocket();
    const ctx = makeMockCtx();

    await handleRideShotgunStart(
      {
        type: "ride_shotgun_start",
        durationSeconds: 60,
        intervalSeconds: 5,
        mode: "observe",
      },
      socket,
      ctx,
    );

    // Give time for any background tasks
    await new Promise((r) => setTimeout(r, 200));

    // In observe mode, no recorder should be started
    expect(mockRecorderStartCalls).toBe(0);

    // Clean up
    const watchId = [...watchSessions.keys()][0]!;
    await handleRideShotgunStop(
      { type: "ride_shotgun_stop", watchId },
      socket,
      ctx,
    );
  });

  test("sends watch_started message with session IDs", async () => {
    const socket = makeMockSocket();
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
      socket,
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
    await handleRideShotgunStop(
      { type: "ride_shotgun_stop", watchId },
      socket,
      ctx,
    );
  });
});
