/**
 * Tests for the `meet_join` tool.
 *
 * Exercises URL validation, feature-flag gating, `{assistantName}`
 * substitution, and the happy-path call into `MeetSessionManager.join`.
 * The session manager is swapped via `mock.module` so the tool under
 * test continues to import the real singleton path — the same one
 * production code uses — without having to thread a parameter through
 * just for tests.
 *
 * The tool itself now takes a `SkillHost` at construction time, so the
 * test builds a minimal fake host (feature-flag reads, logger, assistant
 * name) rather than mocking into `assistant/src/...` directly.
 */

import type { SkillHost, Tool } from "@vellumai/skill-host-contracts";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ----- Mocks wired BEFORE importing the tool ---------------------------------

let flagEnabled = true;
let assistantNameValue: string | undefined = "Nova";
let consentTemplate =
  "Hi, I'm {assistantName}, an AI assistant joining to take notes. Let me know if you'd prefer I leave.";

const joinMock = mock(
  async (input: {
    url: string;
    meetingId: string;
    conversationId: string;
    consentMessage?: string;
  }) => ({
    meetingId: input.meetingId,
    conversationId: input.conversationId,
    containerId: "container-meet",
    botBaseUrl: "http://127.0.0.1:49000",
    botApiToken: "token",
    startedAt: Date.now(),
    joinTimeoutMs: 60_000,
  }),
);

mock.module("../../daemon/session-manager.js", () => ({
  MeetSessionManager: {
    join: joinMock,
    leave: async () => {},
    activeSessions: () => [],
    getSession: () => null,
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

mock.module("../../meet-config.js", () => ({
  getMeetConfig: () => ({
    consentMessage: consentTemplate,
  }),
}));

// Import AFTER the module mocks are installed.
const {
  createMeetJoinTool,
  MEET_URL_REGEX,
  substituteAssistantName,
  DEFAULT_ASSISTANT_NAME,
} = await import("../meet-join-tool.js");

/**
 * Minimal fake `SkillHost` exposing only the facets `createMeetJoinTool`
 * reads: logger, config.isFeatureFlagEnabled, identity.getAssistantName.
 * Every other facet is a throwing proxy so drift into un-plumbed host
 * surfaces fails loudly instead of silently no-opping.
 */
function makeHost(): SkillHost {
  const unreachable = (path: string): never => {
    throw new Error(
      `meet-join-tool.test: fake SkillHost facet ${path} was unexpectedly accessed`,
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
    identity: {
      getAssistantName: () => assistantNameValue,
      internalAssistantId: "self",
    },
    platform: {
      workspaceDir: () => "/tmp/meet-join-tool-test-workspace",
      vellumRoot: () => "/tmp/meet-join-tool-test-vellum",
      runtimeMode: () => "bare-metal" as never,
    },
    providers: throwingProxy("providers") as SkillHost["providers"],
    memory: throwingProxy("memory") as SkillHost["memory"],
    events: throwingProxy("events") as SkillHost["events"],
    registries: throwingProxy("registries") as SkillHost["registries"],
    speakers: throwingProxy("speakers") as SkillHost["speakers"],
  };
}

let meetJoinTool: Tool;

/** Minimal `ToolContext` covering the fields the tool actually reads. */
function makeContext(overrides: { conversationId?: string } = {}): {
  workingDir: string;
  conversationId: string;
  trustClass: string;
} {
  return {
    workingDir: "/tmp",
    conversationId: overrides.conversationId ?? "conv-test",
    trustClass: "guardian",
  };
}

beforeEach(() => {
  flagEnabled = true;
  assistantNameValue = "Nova";
  consentTemplate =
    "Hi, I'm {assistantName}, an AI assistant joining to take notes. Let me know if you'd prefer I leave.";
  joinMock.mockClear();
  meetJoinTool = createMeetJoinTool(makeHost());
});

afterAll(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

describe("MEET_URL_REGEX", () => {
  test.each([
    "https://meet.google.com/abc-defg-hij",
    "https://meet.google.com/abcd-efgh-ijkl",
    "https://meet.google.com/abcdefghij", // no-hyphen variant
    "https://Meet.Google.Com/abc-defg-hij", // case-insensitive host
    "https://meet.google.com/abc-defg-hij?authuser=0",
  ])("accepts valid Meet URL %s", (url) => {
    expect(MEET_URL_REGEX.test(url)).toBe(true);
  });

  test.each([
    "http://meet.google.com/abc-defg-hij", // not https
    "https://zoom.us/j/12345",
    "https://meet.google.com/",
    "https://meet.google.com/abc-defg", // missing trailing block
    "not-a-url",
    "https://meet.google.com/abc-defg-hij/extra",
  ])("rejects non-Meet URL %s", (url) => {
    expect(MEET_URL_REGEX.test(url)).toBe(false);
  });
});

describe("substituteAssistantName", () => {
  test("replaces all occurrences of {assistantName}", () => {
    const result = substituteAssistantName(
      "Hi, I'm {assistantName}. {assistantName} here to help.",
      "Nova",
    );
    expect(result).toBe("Hi, I'm Nova. Nova here to help.");
  });

  test("is a no-op when the template has no placeholder", () => {
    const result = substituteAssistantName("Just a plain greeting.", "Nova");
    expect(result).toBe("Just a plain greeting.");
  });

  test("tolerates regex-magic characters in the name", () => {
    const result = substituteAssistantName(
      "I am {assistantName}.",
      "Bot$1(.*)",
    );
    expect(result).toBe("I am Bot$1(.*).");
  });
});

// ---------------------------------------------------------------------------
// Feature-flag gating
// ---------------------------------------------------------------------------

describe("meet_join feature-flag gating", () => {
  test("returns an error when the meet flag is off", async () => {
    flagEnabled = false;
    meetJoinTool = createMeetJoinTool(makeHost());
    const result = await meetJoinTool.execute(
      { url: "https://meet.google.com/abc-defg-hij" },
      makeContext() as never,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("meet feature is disabled");
    expect(joinMock).not.toHaveBeenCalled();
  });

  test("proceeds to the session manager when the meet flag is on", async () => {
    flagEnabled = true;
    meetJoinTool = createMeetJoinTool(makeHost());
    const result = await meetJoinTool.execute(
      { url: "https://meet.google.com/abc-defg-hij" },
      makeContext() as never,
    );
    expect(result.isError).toBe(false);
    expect(joinMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("meet_join input validation", () => {
  test("rejects a missing url", async () => {
    const result = await meetJoinTool.execute({}, makeContext() as never);
    expect(result.isError).toBe(true);
    // Zod reports "expected string, received undefined" for a missing url;
    // assert the error surfaces as an Error: … payload rather than leaking
    // through to the session manager.
    expect(result.content).toMatch(/^Error:/);
    expect(joinMock).not.toHaveBeenCalled();
  });

  test("rejects a non-Meet url", async () => {
    const result = await meetJoinTool.execute(
      { url: "https://zoom.us/j/12345" },
      makeContext() as never,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Google Meet");
    expect(joinMock).not.toHaveBeenCalled();
  });

  test("accepts a valid Meet url", async () => {
    const result = await meetJoinTool.execute(
      { url: "https://meet.google.com/abc-defg-hij" },
      makeContext() as never,
    );
    expect(result.isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assistantName substitution and delegation
// ---------------------------------------------------------------------------

describe("meet_join session-manager delegation", () => {
  test("substitutes {assistantName} into the consent message before joining", async () => {
    assistantNameValue = "Aria";
    meetJoinTool = createMeetJoinTool(makeHost());
    const result = await meetJoinTool.execute(
      { url: "https://meet.google.com/abc-defg-hij" },
      makeContext({ conversationId: "conv-123" }) as never,
    );

    expect(result.isError).toBe(false);
    expect(joinMock).toHaveBeenCalledTimes(1);
    const call = joinMock.mock.calls[0][0];
    expect(call.url).toBe("https://meet.google.com/abc-defg-hij");
    expect(call.conversationId).toBe("conv-123");
    expect(call.consentMessage).toBeDefined();
    expect(call.consentMessage).not.toContain("{assistantName}");
    expect(call.consentMessage).toContain("Aria");
    expect(call.meetingId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("falls back to the default assistant name when IDENTITY.md is missing", async () => {
    assistantNameValue = undefined;
    meetJoinTool = createMeetJoinTool(makeHost());
    await meetJoinTool.execute(
      { url: "https://meet.google.com/abc-defg-hij" },
      makeContext() as never,
    );
    const call = joinMock.mock.calls[0][0];
    expect(call.consentMessage).toContain(DEFAULT_ASSISTANT_NAME);
    expect(call.consentMessage).not.toContain("{assistantName}");
  });

  test("returns the generated meetingId and joining status", async () => {
    const result = await meetJoinTool.execute(
      { url: "https://meet.google.com/abc-defg-hij" },
      makeContext() as never,
    );
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content) as {
      meetingId: string;
      status: string;
    };
    expect(payload.status).toBe("joining");
    expect(payload.meetingId).toBe(joinMock.mock.calls[0][0].meetingId);
  });

  test("surfaces session-manager errors as tool errors rather than throwing", async () => {
    joinMock.mockImplementationOnce(async () => {
      throw new Error("docker is not running");
    });
    const result = await meetJoinTool.execute(
      { url: "https://meet.google.com/abc-defg-hij" },
      makeContext() as never,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("docker is not running");
  });
});
