/**
 * Tests for the `meet_leave` tool.
 *
 * Exercises feature-flag gating, disambiguation when the caller omits
 * `meetingId` (0 / 1 / many active sessions), explicit-id pass-through,
 * and reason-default behavior. Mirrors the mocking style used in the
 * sibling `meet-join-tool.test.ts`.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

let flagEnabled = true;
let activeSessionsValue: Array<{
  meetingId: string;
  conversationId: string;
  containerId: string;
  botBaseUrl: string;
  botApiToken: string;
  startedAt: number;
  joinTimeoutMs: number;
}> = [];

const leaveMock = mock(async (_meetingId: string, _reason: string) => {});

const getSessionMock = mock((meetingId: string) => {
  const found = activeSessionsValue.find((s) => s.meetingId === meetingId);
  return found ?? null;
});

mock.module("../../daemon/session-manager.js", () => ({
  MeetSessionManager: {
    join: async () => {
      throw new Error("join should not be invoked in leave tests");
    },
    leave: leaveMock,
    activeSessions: () => activeSessionsValue,
    getSession: getSessionMock,
    sendChat: async () => {},
  },
  MeetSessionNotFoundError: class extends Error {
    readonly name = "MeetSessionNotFoundError";
  },
  MeetSessionUnreachableError: class extends Error {
    readonly name = "MeetSessionUnreachableError";
  },
  MeetBotChatError: class extends Error {
    readonly name = "MeetBotChatError";
    readonly status: number = 0;
  },
}));

mock.module(
  "../../../../assistant/src/config/assistant-feature-flags.js",
  () => ({
    isAssistantFeatureFlagEnabled: (key: string) => {
      if (key === "meet") return flagEnabled;
      return true;
    },
  }),
);

mock.module("../../../../assistant/src/config/loader.js", () => ({
  getConfig: () => ({
    services: { meet: { consentMessage: "unused-in-leave-tests" } },
  }),
}));

mock.module("../../../../assistant/src/util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const { meetLeaveTool, DEFAULT_LEAVE_REASON } =
  await import("../meet-leave-tool.js");

import type { ToolContext } from "../../../../assistant/src/tools/types.js";

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "conv-test",
    trustClass: "guardian",
    ...overrides,
  } as ToolContext;
}

function fakeSession(meetingId: string) {
  return {
    meetingId,
    conversationId: "conv-test",
    containerId: `c-${meetingId}`,
    botBaseUrl: "http://127.0.0.1:49000",
    botApiToken: "token",
    startedAt: Date.now(),
    joinTimeoutMs: 60_000,
  };
}

beforeEach(() => {
  flagEnabled = true;
  activeSessionsValue = [];
  leaveMock.mockClear();
  getSessionMock.mockClear();
});

afterAll(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// Feature-flag gating
// ---------------------------------------------------------------------------

describe("meet_leave feature-flag gating", () => {
  test("returns an error when the meet flag is off", async () => {
    flagEnabled = false;
    activeSessionsValue = [fakeSession("m1")];
    const result = await meetLeaveTool.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("meet feature is disabled");
    expect(leaveMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Disambiguation when meetingId is omitted
// ---------------------------------------------------------------------------

describe("meet_leave disambiguation", () => {
  test("errors when no active sessions exist", async () => {
    activeSessionsValue = [];
    const result = await meetLeaveTool.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("no active meet session");
    expect(leaveMock).not.toHaveBeenCalled();
  });

  test("targets the single active session when meetingId is omitted", async () => {
    activeSessionsValue = [fakeSession("solo")];
    const result = await meetLeaveTool.execute(
      { reason: "user-requested" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(leaveMock).toHaveBeenCalledTimes(1);
    const [id, reason] = leaveMock.mock.calls[0];
    expect(id).toBe("solo");
    expect(reason).toBe("user-requested");
    const payload = JSON.parse(result.content) as {
      left: boolean;
      meetingId: string;
    };
    expect(payload).toEqual({ left: true, meetingId: "solo" });
  });

  test("errors when multiple active sessions and meetingId is omitted", async () => {
    activeSessionsValue = [fakeSession("m1"), fakeSession("m2")];
    const result = await meetLeaveTool.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("multiple active");
    expect(result.content).toContain("m1");
    expect(result.content).toContain("m2");
    expect(leaveMock).not.toHaveBeenCalled();
  });

  test("accepts an explicit meetingId even when multiple sessions are active", async () => {
    activeSessionsValue = [fakeSession("m1"), fakeSession("m2")];
    const result = await meetLeaveTool.execute(
      { meetingId: "m2" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(leaveMock).toHaveBeenCalledTimes(1);
    expect(leaveMock.mock.calls[0][0]).toBe("m2");
  });

  test("defaults the reason to DEFAULT_LEAVE_REASON when none provided", async () => {
    activeSessionsValue = [fakeSession("solo")];
    await meetLeaveTool.execute({}, makeContext());
    expect(leaveMock.mock.calls[0][1]).toBe(DEFAULT_LEAVE_REASON);
  });

  test("trims whitespace-only reasons and falls back to the default", async () => {
    activeSessionsValue = [fakeSession("solo")];
    await meetLeaveTool.execute({ reason: "   " }, makeContext());
    expect(leaveMock.mock.calls[0][1]).toBe(DEFAULT_LEAVE_REASON);
  });

  test("returns a left=false payload when the meetingId does not match any active session", async () => {
    // Explicit id that the session manager has no record of — leave() is
    // still called (it's idempotent) but the caller should know nothing
    // happened.
    activeSessionsValue = [];
    const result = await meetLeaveTool.execute(
      { meetingId: "unknown" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content) as {
      left: boolean;
      meetingId: string;
    };
    expect(payload.left).toBe(false);
    expect(payload.meetingId).toBe("unknown");
    expect(leaveMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Error surfacing
// ---------------------------------------------------------------------------

describe("meet_leave error surfacing", () => {
  test("surfaces session-manager errors as tool errors rather than throwing", async () => {
    activeSessionsValue = [fakeSession("solo")];
    leaveMock.mockImplementationOnce(async () => {
      throw new Error("container stop timed out");
    });
    const result = await meetLeaveTool.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("container stop timed out");
  });
});
