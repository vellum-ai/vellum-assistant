/**
 * Tests for the `meet_enable_avatar` and `meet_disable_avatar` tools.
 *
 * Exercises feature-flag gating, input validation (optional meetingId),
 * disambiguation when the caller omits `meetingId` (0 / 1 / many active
 * sessions), explicit-id pass-through, and error propagation from the
 * session manager. Mirrors the mocking style used in the sibling
 * `meet-send-chat-tool.test.ts` / `meet-speak-tool.test.ts`.
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

const enableAvatarMock = mock(
  async (_meetingId: string): Promise<Record<string, unknown>> => ({
    enabled: true,
    renderer: "noop",
    active: false,
  }),
);
const disableAvatarMock = mock(
  async (_meetingId: string): Promise<Record<string, unknown>> => ({
    disabled: true,
    wasActive: false,
  }),
);

class FakeMeetSessionNotFoundError extends Error {
  readonly name = "MeetSessionNotFoundError";
}
class FakeMeetSessionUnreachableError extends Error {
  readonly name = "MeetSessionUnreachableError";
}
class FakeMeetBotAvatarError extends Error {
  readonly name = "MeetBotAvatarError";
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
class FakeMeetBotChatError extends Error {
  readonly name = "MeetBotChatError";
  readonly status: number = 0;
}

// All error classes exported from the real session-manager module are
// reproduced here so sibling test files (e.g. meet-send-chat-tool.test.ts)
// don't hit a "Export named 'MeetBotChatError' not found" error when bun's
// module cache reuses this mock across files in the same run.
mock.module("../../daemon/session-manager.js", () => ({
  MeetSessionManager: {
    join: async () => {
      throw new Error("join should not be invoked in avatar tests");
    },
    leave: async () => {},
    activeSessions: () => activeSessionsValue,
    getSession: (meetingId: string) =>
      activeSessionsValue.find((s) => s.meetingId === meetingId) ?? null,
    sendChat: async () => {},
    speak: async () => ({ streamId: "unused" }),
    cancelSpeak: async () => {},
    enableAvatar: enableAvatarMock,
    disableAvatar: disableAvatarMock,
  },
  MeetSessionNotFoundError: FakeMeetSessionNotFoundError,
  MeetSessionUnreachableError: FakeMeetSessionUnreachableError,
  MeetBotAvatarError: FakeMeetBotAvatarError,
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
    services: { meet: { consentMessage: "unused-in-avatar-tests" } },
  }),
}));

mock.module("../../../../assistant/src/util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const { meetEnableAvatarTool, meetDisableAvatarTool } = await import(
  "../meet-avatar-tool.js"
);

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
  enableAvatarMock.mockClear();
  enableAvatarMock.mockImplementation(async () => ({
    enabled: true,
    renderer: "noop",
    active: false,
  }));
  disableAvatarMock.mockClear();
  disableAvatarMock.mockImplementation(async () => ({
    disabled: true,
    wasActive: false,
  }));
});

afterAll(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// meet_enable_avatar — feature-flag gating
// ---------------------------------------------------------------------------

describe("meet_enable_avatar feature-flag gating", () => {
  test("returns an error when the meet flag is off", async () => {
    flagEnabled = false;
    activeSessionsValue = [fakeSession("m1")];
    const result = await meetEnableAvatarTool.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("meet feature is disabled");
    expect(enableAvatarMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// meet_enable_avatar — input validation
// ---------------------------------------------------------------------------

describe("meet_enable_avatar input validation", () => {
  test("rejects non-string meetingId", async () => {
    activeSessionsValue = [fakeSession("solo")];
    const result = await meetEnableAvatarTool.execute(
      { meetingId: 123 },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(enableAvatarMock).not.toHaveBeenCalled();
  });

  test("rejects empty-string meetingId", async () => {
    activeSessionsValue = [fakeSession("solo")];
    const result = await meetEnableAvatarTool.execute(
      { meetingId: "  " },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(enableAvatarMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// meet_enable_avatar — disambiguation
// ---------------------------------------------------------------------------

describe("meet_enable_avatar disambiguation", () => {
  test("errors when no active sessions exist", async () => {
    activeSessionsValue = [];
    const result = await meetEnableAvatarTool.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("no active meet session");
    expect(enableAvatarMock).not.toHaveBeenCalled();
  });

  test("targets the single active session when meetingId is omitted", async () => {
    activeSessionsValue = [fakeSession("solo")];
    enableAvatarMock.mockImplementationOnce(async () => ({
      enabled: true,
      renderer: "talking-head",
      active: true,
      devicePath: "/dev/video10",
    }));
    const result = await meetEnableAvatarTool.execute({}, makeContext());
    expect(result.isError).toBe(false);
    expect(enableAvatarMock).toHaveBeenCalledTimes(1);
    expect(enableAvatarMock.mock.calls[0][0]).toBe("solo");
    const body = JSON.parse(result.content) as {
      meetingId: string;
      enabled: boolean;
      renderer: string;
      active: boolean;
      devicePath: string;
    };
    expect(body).toEqual({
      meetingId: "solo",
      enabled: true,
      renderer: "talking-head",
      active: true,
      devicePath: "/dev/video10",
    });
  });

  test("errors when multiple active sessions and meetingId is omitted", async () => {
    activeSessionsValue = [fakeSession("m1"), fakeSession("m2")];
    const result = await meetEnableAvatarTool.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("multiple active");
    expect(result.content).toContain("m1");
    expect(result.content).toContain("m2");
    expect(enableAvatarMock).not.toHaveBeenCalled();
  });

  test("accepts an explicit meetingId even when multiple sessions are active", async () => {
    activeSessionsValue = [fakeSession("m1"), fakeSession("m2")];
    const result = await meetEnableAvatarTool.execute(
      { meetingId: "m2" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(enableAvatarMock).toHaveBeenCalledTimes(1);
    expect(enableAvatarMock.mock.calls[0][0]).toBe("m2");
  });
});

// ---------------------------------------------------------------------------
// meet_enable_avatar — error propagation
// ---------------------------------------------------------------------------

describe("meet_enable_avatar error propagation", () => {
  test("surfaces MeetSessionNotFoundError as a targeted tool error", async () => {
    activeSessionsValue = [fakeSession("solo")];
    enableAvatarMock.mockImplementationOnce(async () => {
      throw new FakeMeetSessionNotFoundError("no session");
    });
    const result = await meetEnableAvatarTool.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no active Meet session");
    expect(result.content).toContain("solo");
  });

  test("surfaces MeetSessionUnreachableError with a bot-unreachable message", async () => {
    activeSessionsValue = [fakeSession("solo")];
    enableAvatarMock.mockImplementationOnce(async () => {
      throw new FakeMeetSessionUnreachableError("connect ECONNREFUSED");
    });
    const result = await meetEnableAvatarTool.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("meet bot unreachable");
    expect(result.content).toContain("ECONNREFUSED");
  });

  test("surfaces MeetBotAvatarError with the upstream status code", async () => {
    activeSessionsValue = [fakeSession("solo")];
    enableAvatarMock.mockImplementationOnce(async () => {
      throw new FakeMeetBotAvatarError("renderer unavailable", 503);
    });
    const result = await meetEnableAvatarTool.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("status 503");
    expect(result.content).toContain("renderer unavailable");
  });

  test("surfaces unknown errors verbatim", async () => {
    activeSessionsValue = [fakeSession("solo")];
    enableAvatarMock.mockImplementationOnce(async () => {
      throw new Error("something exploded");
    });
    const result = await meetEnableAvatarTool.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("failed to enable Meet avatar");
    expect(result.content).toContain("something exploded");
  });
});

// ---------------------------------------------------------------------------
// meet_disable_avatar — feature-flag gating
// ---------------------------------------------------------------------------

describe("meet_disable_avatar feature-flag gating", () => {
  test("returns an error when the meet flag is off", async () => {
    flagEnabled = false;
    activeSessionsValue = [fakeSession("m1")];
    const result = await meetDisableAvatarTool.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("meet feature is disabled");
    expect(disableAvatarMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// meet_disable_avatar — disambiguation
// ---------------------------------------------------------------------------

describe("meet_disable_avatar disambiguation", () => {
  test("errors when no active sessions exist", async () => {
    activeSessionsValue = [];
    const result = await meetDisableAvatarTool.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("no active meet session");
    expect(disableAvatarMock).not.toHaveBeenCalled();
  });

  test("targets the single active session when meetingId is omitted", async () => {
    activeSessionsValue = [fakeSession("solo")];
    disableAvatarMock.mockImplementationOnce(async () => ({
      disabled: true,
      wasActive: true,
      cameraChanged: true,
    }));
    const result = await meetDisableAvatarTool.execute({}, makeContext());
    expect(result.isError).toBe(false);
    expect(disableAvatarMock).toHaveBeenCalledTimes(1);
    expect(disableAvatarMock.mock.calls[0][0]).toBe("solo");
    const body = JSON.parse(result.content) as {
      meetingId: string;
      disabled: boolean;
      wasActive: boolean;
      cameraChanged: boolean;
    };
    expect(body).toEqual({
      meetingId: "solo",
      disabled: true,
      wasActive: true,
      cameraChanged: true,
    });
  });

  test("errors when multiple active sessions and meetingId is omitted", async () => {
    activeSessionsValue = [fakeSession("m1"), fakeSession("m2")];
    const result = await meetDisableAvatarTool.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("multiple active");
    expect(disableAvatarMock).not.toHaveBeenCalled();
  });

  test("accepts an explicit meetingId even when multiple sessions are active", async () => {
    activeSessionsValue = [fakeSession("m1"), fakeSession("m2")];
    const result = await meetDisableAvatarTool.execute(
      { meetingId: "m1" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(disableAvatarMock).toHaveBeenCalledTimes(1);
    expect(disableAvatarMock.mock.calls[0][0]).toBe("m1");
  });
});

// ---------------------------------------------------------------------------
// meet_disable_avatar — error propagation
// ---------------------------------------------------------------------------

describe("meet_disable_avatar error propagation", () => {
  test("surfaces MeetSessionNotFoundError as a targeted tool error", async () => {
    activeSessionsValue = [fakeSession("solo")];
    disableAvatarMock.mockImplementationOnce(async () => {
      throw new FakeMeetSessionNotFoundError("no session");
    });
    const result = await meetDisableAvatarTool.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no active Meet session");
    expect(result.content).toContain("solo");
  });

  test("surfaces MeetSessionUnreachableError with a bot-unreachable message", async () => {
    activeSessionsValue = [fakeSession("solo")];
    disableAvatarMock.mockImplementationOnce(async () => {
      throw new FakeMeetSessionUnreachableError("connect ECONNREFUSED");
    });
    const result = await meetDisableAvatarTool.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("meet bot unreachable");
    expect(result.content).toContain("ECONNREFUSED");
  });

  test("surfaces MeetBotAvatarError with the upstream status code", async () => {
    activeSessionsValue = [fakeSession("solo")];
    disableAvatarMock.mockImplementationOnce(async () => {
      throw new FakeMeetBotAvatarError("teardown failed", 500);
    });
    const result = await meetDisableAvatarTool.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("status 500");
    expect(result.content).toContain("teardown failed");
  });

  test("surfaces unknown errors verbatim", async () => {
    activeSessionsValue = [fakeSession("solo")];
    disableAvatarMock.mockImplementationOnce(async () => {
      throw new Error("kernel panic");
    });
    const result = await meetDisableAvatarTool.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("failed to disable Meet avatar");
    expect(result.content).toContain("kernel panic");
  });
});
