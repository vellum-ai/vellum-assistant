/**
 * Tests for the `meet_speak` and `meet_cancel_speak` tools.
 *
 * Exercises feature-flag gating, input validation (length cap, optional
 * voice, optional meetingId), disambiguation when the caller omits
 * `meetingId` (0 / 1 / many active sessions), explicit-id pass-through,
 * and error propagation from the session manager. Mirrors the mocking
 * style used in the sibling `meet-send-chat-tool.test.ts`.
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

const speakMock = mock(
  async (
    _meetingId: string,
    _input: { text: string; voice?: string },
  ): Promise<{ streamId: string }> => {
    return { streamId: "stream-default" };
  },
);
const cancelSpeakMock = mock(async (_meetingId: string): Promise<void> => {});

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
      throw new Error("join should not be invoked in speak tests");
    },
    leave: async () => {},
    activeSessions: () => activeSessionsValue,
    getSession: (meetingId: string) =>
      activeSessionsValue.find((s) => s.meetingId === meetingId) ?? null,
    sendChat: async () => {},
    speak: speakMock,
    cancelSpeak: cancelSpeakMock,
  },
  MeetSessionNotFoundError: FakeMeetSessionNotFoundError,
  MeetSessionUnreachableError: FakeMeetSessionUnreachableError,
  MeetBotChatError: FakeMeetBotChatError,
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
    services: { meet: { consentMessage: "unused-in-speak-tests" } },
  }),
}));

mock.module("../../../../assistant/src/util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const { meetSpeakTool, meetCancelSpeakTool, MEET_SPEAK_MAX_TEXT_LENGTH } =
  await import("../meet-speak-tool.js");

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
  speakMock.mockClear();
  speakMock.mockImplementation(async () => ({ streamId: "stream-default" }));
  cancelSpeakMock.mockClear();
  cancelSpeakMock.mockImplementation(async () => {});
});

afterAll(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// meet_speak — feature-flag gating
// ---------------------------------------------------------------------------

describe("meet_speak feature-flag gating", () => {
  test("returns an error when the meet flag is off", async () => {
    flagEnabled = false;
    activeSessionsValue = [fakeSession("m1")];
    const result = await meetSpeakTool.execute(
      { text: "hello" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("meet feature is disabled");
    expect(speakMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// meet_speak — input validation
// ---------------------------------------------------------------------------

describe("meet_speak input validation", () => {
  test("rejects missing text", async () => {
    activeSessionsValue = [fakeSession("solo")];
    const result = await meetSpeakTool.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/^Error:/);
    expect(speakMock).not.toHaveBeenCalled();
  });

  test("rejects empty text", async () => {
    activeSessionsValue = [fakeSession("solo")];
    const result = await meetSpeakTool.execute({ text: "" }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("text");
    expect(speakMock).not.toHaveBeenCalled();
  });

  test("rejects non-string text", async () => {
    activeSessionsValue = [fakeSession("solo")];
    const result = await meetSpeakTool.execute({ text: 123 }, makeContext());
    expect(result.isError).toBe(true);
    expect(speakMock).not.toHaveBeenCalled();
  });

  test("accepts text exactly at the soft length cap", async () => {
    activeSessionsValue = [fakeSession("solo")];
    const text = "a".repeat(MEET_SPEAK_MAX_TEXT_LENGTH);
    const result = await meetSpeakTool.execute({ text }, makeContext());
    expect(result.isError).toBe(false);
    expect(speakMock).toHaveBeenCalledTimes(1);
    expect(speakMock.mock.calls[0][1].text.length).toBe(
      MEET_SPEAK_MAX_TEXT_LENGTH,
    );
  });

  test("rejects text exceeding the soft length cap", async () => {
    activeSessionsValue = [fakeSession("solo")];
    const text = "a".repeat(MEET_SPEAK_MAX_TEXT_LENGTH + 1);
    const result = await meetSpeakTool.execute({ text }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain(`${MEET_SPEAK_MAX_TEXT_LENGTH}`);
    expect(result.content.toLowerCase()).toContain("meet_send_chat");
    expect(speakMock).not.toHaveBeenCalled();
  });

  test("rejects empty voice when provided", async () => {
    activeSessionsValue = [fakeSession("solo")];
    const result = await meetSpeakTool.execute(
      { text: "hi", voice: "  " },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(speakMock).not.toHaveBeenCalled();
  });

  test("passes through an explicit voice id to the session manager", async () => {
    activeSessionsValue = [fakeSession("solo")];
    speakMock.mockImplementationOnce(async () => ({
      streamId: "stream-voice",
    }));
    const result = await meetSpeakTool.execute(
      { text: "hi there", voice: "alloy" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(speakMock).toHaveBeenCalledTimes(1);
    expect(speakMock.mock.calls[0][1]).toEqual({
      text: "hi there",
      voice: "alloy",
    });
  });
});

// ---------------------------------------------------------------------------
// meet_speak — disambiguation
// ---------------------------------------------------------------------------

describe("meet_speak disambiguation", () => {
  test("errors when no active sessions exist", async () => {
    activeSessionsValue = [];
    const result = await meetSpeakTool.execute(
      { text: "anyone there?" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("no active meet session");
    expect(speakMock).not.toHaveBeenCalled();
  });

  test("targets the single active session when meetingId is omitted", async () => {
    activeSessionsValue = [fakeSession("solo")];
    speakMock.mockImplementationOnce(async () => ({
      streamId: "stream-1",
    }));
    const result = await meetSpeakTool.execute(
      { text: "hello team" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(speakMock).toHaveBeenCalledTimes(1);
    const [id, payload] = speakMock.mock.calls[0];
    expect(id).toBe("solo");
    expect(payload.text).toBe("hello team");
    const body = JSON.parse(result.content) as {
      streamId: string;
      meetingId: string;
    };
    expect(body).toEqual({ streamId: "stream-1", meetingId: "solo" });
  });

  test("errors when multiple active sessions and meetingId is omitted", async () => {
    activeSessionsValue = [fakeSession("m1"), fakeSession("m2")];
    const result = await meetSpeakTool.execute({ text: "hi" }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("multiple active");
    expect(result.content).toContain("m1");
    expect(result.content).toContain("m2");
    expect(speakMock).not.toHaveBeenCalled();
  });

  test("accepts an explicit meetingId even when multiple sessions are active", async () => {
    activeSessionsValue = [fakeSession("m1"), fakeSession("m2")];
    speakMock.mockImplementationOnce(async () => ({
      streamId: "stream-m2",
    }));
    const result = await meetSpeakTool.execute(
      { meetingId: "m2", text: "hi m2" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(speakMock).toHaveBeenCalledTimes(1);
    expect(speakMock.mock.calls[0][0]).toBe("m2");
    expect(speakMock.mock.calls[0][1].text).toBe("hi m2");
  });
});

// ---------------------------------------------------------------------------
// meet_speak — error propagation
// ---------------------------------------------------------------------------

describe("meet_speak error propagation", () => {
  test("surfaces MeetSessionNotFoundError as a targeted tool error", async () => {
    activeSessionsValue = [fakeSession("solo")];
    speakMock.mockImplementationOnce(async () => {
      throw new FakeMeetSessionNotFoundError("no session");
    });
    const result = await meetSpeakTool.execute(
      { text: "hello" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no active Meet session");
    expect(result.content).toContain("solo");
  });

  test("surfaces unknown errors verbatim", async () => {
    activeSessionsValue = [fakeSession("solo")];
    speakMock.mockImplementationOnce(async () => {
      throw new Error("ffmpeg crashed");
    });
    const result = await meetSpeakTool.execute(
      { text: "hello" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("failed to speak into Meet");
    expect(result.content).toContain("ffmpeg crashed");
  });
});

// ---------------------------------------------------------------------------
// meet_cancel_speak — feature-flag gating
// ---------------------------------------------------------------------------

describe("meet_cancel_speak feature-flag gating", () => {
  test("returns an error when the meet flag is off", async () => {
    flagEnabled = false;
    activeSessionsValue = [fakeSession("m1")];
    const result = await meetCancelSpeakTool.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("meet feature is disabled");
    expect(cancelSpeakMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// meet_cancel_speak — disambiguation
// ---------------------------------------------------------------------------

describe("meet_cancel_speak disambiguation", () => {
  test("errors when no active sessions exist", async () => {
    activeSessionsValue = [];
    const result = await meetCancelSpeakTool.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("no active meet session");
    expect(cancelSpeakMock).not.toHaveBeenCalled();
  });

  test("cancels the single active session when meetingId is omitted", async () => {
    activeSessionsValue = [fakeSession("solo")];
    const result = await meetCancelSpeakTool.execute({}, makeContext());
    expect(result.isError).toBe(false);
    expect(cancelSpeakMock).toHaveBeenCalledTimes(1);
    expect(cancelSpeakMock.mock.calls[0][0]).toBe("solo");
    const body = JSON.parse(result.content) as {
      cancelled: boolean;
      meetingId: string;
    };
    expect(body).toEqual({ cancelled: true, meetingId: "solo" });
  });

  test("errors when multiple active sessions and meetingId is omitted", async () => {
    activeSessionsValue = [fakeSession("m1"), fakeSession("m2")];
    const result = await meetCancelSpeakTool.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("multiple active");
    expect(cancelSpeakMock).not.toHaveBeenCalled();
  });

  test("accepts an explicit meetingId even when multiple sessions are active", async () => {
    activeSessionsValue = [fakeSession("m1"), fakeSession("m2")];
    const result = await meetCancelSpeakTool.execute(
      { meetingId: "m1" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(cancelSpeakMock).toHaveBeenCalledTimes(1);
    expect(cancelSpeakMock.mock.calls[0][0]).toBe("m1");
  });
});

// ---------------------------------------------------------------------------
// meet_cancel_speak — error propagation
// ---------------------------------------------------------------------------

describe("meet_cancel_speak error propagation", () => {
  test("surfaces MeetSessionNotFoundError as a targeted tool error", async () => {
    activeSessionsValue = [fakeSession("solo")];
    cancelSpeakMock.mockImplementationOnce(async () => {
      throw new FakeMeetSessionNotFoundError("no session");
    });
    const result = await meetCancelSpeakTool.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no active Meet session");
    expect(result.content).toContain("solo");
  });

  test("surfaces unknown errors verbatim", async () => {
    activeSessionsValue = [fakeSession("solo")];
    cancelSpeakMock.mockImplementationOnce(async () => {
      throw new Error("bridge cancel failed");
    });
    const result = await meetCancelSpeakTool.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("failed to cancel Meet speech");
    expect(result.content).toContain("bridge cancel failed");
  });
});
