/**
 * Tests for the `meet_send_chat` tool.
 *
 * Exercises feature-flag gating, input validation, disambiguation when the
 * caller omits `meetingId` (0 / 1 / many active sessions), explicit-id
 * pass-through, and error propagation from the session manager. Mirrors
 * the mocking style used in the sibling `meet-leave-tool.test.ts`.
 *
 * The tool is now constructed via `createMeetSendChatTool(host)`, so the
 * test builds a minimal fake host (feature-flag reads, no-op logger) to
 * drive it.
 */

import type { SkillHost, Tool } from "@vellumai/skill-host-contracts";
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

const sendChatMock = mock(async (_meetingId: string, _text: string) => {});

class FakeMeetSessionNotFoundError extends Error {
  readonly name = "MeetSessionNotFoundError";
}
class FakeMeetSessionUnreachableError extends Error {
  readonly name = "MeetSessionUnreachableError";
}
class FakeMeetBotChatError extends Error {
  readonly name = "MeetBotChatError";
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

mock.module("../../daemon/session-manager.js", () => ({
  MeetSessionManager: {
    join: async () => {
      throw new Error("join should not be invoked in send-chat tests");
    },
    leave: async () => {},
    activeSessions: () => activeSessionsValue,
    getSession: (meetingId: string) =>
      activeSessionsValue.find((s) => s.meetingId === meetingId) ?? null,
    sendChat: sendChatMock,
  },
  MeetSessionNotFoundError: FakeMeetSessionNotFoundError,
  MeetSessionUnreachableError: FakeMeetSessionUnreachableError,
  MeetBotChatError: FakeMeetBotChatError,
}));

const { createMeetSendChatTool } = await import("../meet-send-chat-tool.js");

function makeHost(): SkillHost {
  const unreachable = (path: string): never => {
    throw new Error(
      `meet-send-chat-tool.test: fake SkillHost facet ${path} was unexpectedly accessed`,
    );
  };
  const throwingProxy = (path: string) =>
    new Proxy({}, { get: (_t, p) => unreachable(`${path}.${String(p)}`) });

  return {
    logger: {
      get: () =>
        new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
    } as SkillHost["logger"],
    config: {
      isFeatureFlagEnabled: (key: string) =>
        key === "meet" ? flagEnabled : true,
      getSection: () => undefined,
    },
    identity: throwingProxy("identity") as SkillHost["identity"],
    platform: throwingProxy("platform") as SkillHost["platform"],
    providers: throwingProxy("providers") as SkillHost["providers"],
    memory: throwingProxy("memory") as SkillHost["memory"],
    events: throwingProxy("events") as SkillHost["events"],
    registries: throwingProxy("registries") as SkillHost["registries"],
    speakers: throwingProxy("speakers") as SkillHost["speakers"],
  };
}

let meetSendChatTool: Tool;

function makeContext(): {
  workingDir: string;
  conversationId: string;
  trustClass: string;
} {
  return {
    workingDir: "/tmp",
    conversationId: "conv-test",
    trustClass: "guardian",
  };
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
  sendChatMock.mockClear();
  sendChatMock.mockImplementation(async () => {});
  meetSendChatTool = createMeetSendChatTool(makeHost());
});

afterAll(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// Feature-flag gating
// ---------------------------------------------------------------------------

describe("meet_send_chat feature-flag gating", () => {
  test("returns an error when the meet flag is off", async () => {
    flagEnabled = false;
    meetSendChatTool = createMeetSendChatTool(makeHost());
    activeSessionsValue = [fakeSession("m1")];
    const result = await meetSendChatTool.execute(
      { text: "hello" },
      makeContext() as never,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("meet feature is disabled");
    expect(sendChatMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("meet_send_chat input validation", () => {
  test("rejects missing text", async () => {
    activeSessionsValue = [fakeSession("solo")];
    const result = await meetSendChatTool.execute({}, makeContext() as never);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/^Error:/);
    expect(sendChatMock).not.toHaveBeenCalled();
  });

  test("rejects empty text", async () => {
    activeSessionsValue = [fakeSession("solo")];
    const result = await meetSendChatTool.execute(
      { text: "" },
      makeContext() as never,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("text");
    expect(sendChatMock).not.toHaveBeenCalled();
  });

  test("rejects non-string text", async () => {
    activeSessionsValue = [fakeSession("solo")];
    const result = await meetSendChatTool.execute(
      { text: 123 },
      makeContext() as never,
    );
    expect(result.isError).toBe(true);
    expect(sendChatMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Disambiguation when meetingId is omitted
// ---------------------------------------------------------------------------

describe("meet_send_chat disambiguation", () => {
  test("errors when no active sessions exist", async () => {
    activeSessionsValue = [];
    const result = await meetSendChatTool.execute(
      { text: "hi there" },
      makeContext() as never,
    );
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("no active meet session");
    expect(sendChatMock).not.toHaveBeenCalled();
  });

  test("targets the single active session when meetingId is omitted", async () => {
    activeSessionsValue = [fakeSession("solo")];
    const result = await meetSendChatTool.execute(
      { text: "hello team" },
      makeContext() as never,
    );
    expect(result.isError).toBe(false);
    expect(sendChatMock).toHaveBeenCalledTimes(1);
    const [id, text] = sendChatMock.mock.calls[0];
    expect(id).toBe("solo");
    expect(text).toBe("hello team");
    const payload = JSON.parse(result.content) as {
      sent: boolean;
      meetingId: string;
    };
    expect(payload).toEqual({ sent: true, meetingId: "solo" });
  });

  test("errors when multiple active sessions and meetingId is omitted", async () => {
    activeSessionsValue = [fakeSession("m1"), fakeSession("m2")];
    const result = await meetSendChatTool.execute(
      { text: "hi" },
      makeContext() as never,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("multiple active");
    expect(result.content).toContain("m1");
    expect(result.content).toContain("m2");
    expect(sendChatMock).not.toHaveBeenCalled();
  });

  test("accepts an explicit meetingId even when multiple sessions are active", async () => {
    activeSessionsValue = [fakeSession("m1"), fakeSession("m2")];
    const result = await meetSendChatTool.execute(
      { meetingId: "m2", text: "hi m2" },
      makeContext() as never,
    );
    expect(result.isError).toBe(false);
    expect(sendChatMock).toHaveBeenCalledTimes(1);
    expect(sendChatMock.mock.calls[0][0]).toBe("m2");
    expect(sendChatMock.mock.calls[0][1]).toBe("hi m2");
  });
});

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------

describe("meet_send_chat error propagation", () => {
  test("surfaces MeetSessionNotFoundError as a targeted tool error", async () => {
    activeSessionsValue = [fakeSession("solo")];
    sendChatMock.mockImplementationOnce(async () => {
      throw new FakeMeetSessionNotFoundError("no session");
    });
    const result = await meetSendChatTool.execute(
      { text: "hello" },
      makeContext() as never,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no active Meet session");
    expect(result.content).toContain("solo");
  });

  test("surfaces MeetSessionUnreachableError with a bot-unreachable message", async () => {
    activeSessionsValue = [fakeSession("solo")];
    sendChatMock.mockImplementationOnce(async () => {
      throw new FakeMeetSessionUnreachableError("connect ECONNREFUSED");
    });
    const result = await meetSendChatTool.execute(
      { text: "hello" },
      makeContext() as never,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("meet bot unreachable");
    expect(result.content).toContain("ECONNREFUSED");
  });

  test("surfaces MeetBotChatError with the upstream status code", async () => {
    activeSessionsValue = [fakeSession("solo")];
    sendChatMock.mockImplementationOnce(async () => {
      throw new FakeMeetBotChatError("upstream meet chat failed", 502);
    });
    const result = await meetSendChatTool.execute(
      { text: "hello" },
      makeContext() as never,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("status 502");
    expect(result.content).toContain("upstream meet chat failed");
  });

  test("surfaces unknown errors verbatim", async () => {
    activeSessionsValue = [fakeSession("solo")];
    sendChatMock.mockImplementationOnce(async () => {
      throw new Error("something exploded");
    });
    const result = await meetSendChatTool.execute(
      { text: "hello" },
      makeContext() as never,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("failed to send Meet chat");
    expect(result.content).toContain("something exploded");
  });
});
