import { describe, expect, test } from "bun:test";
import type {
  ModeSession,
  ModeSessionMode,
  ModeSessionSummary,
} from "@vellumai/assistant-api";

import type { DisplayMessage } from "@/domains/chat/types/types";
import type {
  MessageItem,
  ThinkingItem,
  TranscriptItem,
} from "@/domains/chat/transcript/types";

import {
  groupSessionItems,
  type SessionGroupSegment,
} from "./group-session-items";

const CONVERSATION_ID = "conv-123";
const SESSION_ID = "session-123";

function messageItem(
  id: string,
  role: DisplayMessage["role"],
  timestamp: number,
  overrides: Partial<DisplayMessage> = {},
): MessageItem {
  const message: DisplayMessage = { id, role, timestamp, ...overrides };
  return { kind: "message", key: id, message };
}

function completedSummary(
  overrides: Partial<ModeSessionSummary> = {},
): ModeSessionSummary {
  return {
    id: SESSION_ID,
    conversationId: CONVERSATION_ID,
    mode: "browser",
    status: "completed",
    sourceStartedAt: 1_000,
    firstIncludedAt: 2_000,
    firstIncludedMessageId: "assistant-1",
    lastActivityAt: 5_000,
    lastOwnedMessageId: "assistant-2",
    endedAt: 6_000,
    endReason: "completed",
    revision: 1,
    ...overrides,
  } as ModeSessionSummary;
}

function project({
  items,
  summary = completedSummary(),
  memberships,
}: {
  items: TranscriptItem[];
  summary?: ModeSessionSummary;
  memberships: Record<string, ModeSession | null>;
}) {
  return groupSessionItems({
    items,
    conversationId: CONVERSATION_ID,
    summariesById: new Map([[summary.id, summary]]),
    getModeSession: (message) => memberships[message.id],
  });
}

function membership(
  mode: ModeSessionMode = "browser",
  id = SESSION_ID,
): ModeSession {
  return { id, mode };
}

function expectSegment(value: TranscriptItem | SessionGroupSegment) {
  expect(value.kind).toBe("sessionGroup");
  return value as SessionGroupSegment;
}

describe("assistant-first session grouping", () => {
  test("keeps the opening user outside and includes later matching exchanges", () => {
    const openingUser = messageItem("user-1", "user", 1_000);
    const firstAssistant = messageItem("assistant-1", "assistant", 2_000);
    const answer = messageItem("user-2", "user", 3_000);
    const finalAssistant = messageItem("assistant-2", "assistant", 5_000);
    const session = membership();

    const result = project({
      items: [openingUser, firstAssistant, answer, finalAssistant],
      memberships: {
        "user-1": session,
        "assistant-1": session,
        "user-2": session,
        "assistant-2": session,
      },
    });

    expect(result[0]).toBe(openingUser);
    const segment = expectSegment(result[1]!);
    expect(segment.items).toEqual([firstAssistant, answer, finalAssistant]);
    expect(segment.rawMemberMessageIds).toEqual([
      "user-1",
      "assistant-1",
      "user-2",
      "assistant-2",
    ]);
    expect(segment.memberMessageIds).toEqual([
      "assistant-1",
      "user-2",
      "assistant-2",
    ]);
    expect(segment.firstActivityAt).toBe(2_000);
    expect(segment.lastActivityAt).toBe(5_000);
    expect(segment.containsFirstBoundary).toBe(true);
    expect(segment.containsLastBoundary).toBe(true);
  });

  test("leaves a user-only run flat", () => {
    const user = messageItem("user-1", "user", 1_000);
    expect(
      project({
        items: [user],
        memberships: { "user-1": membership() },
      }),
    ).toEqual([user]);
  });
});

describe("Live vision prefix grouping", () => {
  test("includes the camera and user prefix once an assistant reply exists", () => {
    const frame: DisplayMessage = {
      id: "frame-1",
      role: "user",
      timestamp: 1_000,
      isCameraFrame: true,
    };
    const user = messageItem("user-1", "user", 1_500);
    user.cameraFrames = [frame];
    const assistant = messageItem("assistant-1", "assistant", 2_000);
    const live = membership("live_vision");

    const result = project({
      items: [user, assistant],
      summary: completedSummary({
        mode: "live_vision",
        firstIncludedMessageId: "frame-1",
        lastOwnedMessageId: "assistant-1",
      }),
      memberships: {
        "frame-1": live,
        "user-1": live,
        "assistant-1": live,
      },
    });

    const segment = expectSegment(result[0]!);
    expect(segment.items).toEqual([user, assistant]);
    expect(segment.memberMessageIds).toEqual([
      "frame-1",
      "user-1",
      "assistant-1",
    ]);
    expect(segment.containsFirstBoundary).toBe(true);
  });

  test("leaves frames flat until an assistant reply exists", () => {
    const frame = messageItem("frame-1", "user", 1_000, {
      isCameraFrame: true,
    });
    const live = membership("live_vision");

    expect(
      project({
        items: [frame],
        summary: completedSummary({ mode: "live_vision" }),
        memberships: { "frame-1": live },
      }),
    ).toEqual([frame]);
  });
});

describe("membership boundaries", () => {
  test("keeps disjoint segments with the same session id separate", () => {
    const first = messageItem("assistant-1", "assistant", 2_000);
    const unrelated = messageItem("other", "assistant", 3_000);
    const second = messageItem("assistant-2", "assistant", 5_000);
    const session = membership();

    const result = project({
      items: [first, unrelated, second],
      memberships: {
        "assistant-1": session,
        other: null,
        "assistant-2": session,
      },
    });

    expect(expectSegment(result[0]!).items).toEqual([first]);
    expect(result[1]).toBe(unrelated);
    expect(expectSegment(result[2]!).items).toEqual([second]);
    expect(result[0]!.key).not.toBe(result[2]!.key);
  });

  test("rejects a rendered camera item with mixed ownership", () => {
    const frame: DisplayMessage = {
      id: "frame-1",
      role: "user",
      timestamp: 1_000,
      isCameraFrame: true,
    };
    const host = messageItem("user-1", "user", 1_500);
    host.cameraFrames = [frame];
    const assistant = messageItem("assistant-1", "assistant", 2_000);

    expect(
      project({
        items: [host, assistant],
        memberships: {
          "frame-1": membership(),
          "user-1": membership("computer_use"),
          "assistant-1": membership(),
        },
      }),
    ).toEqual([host, expect.any(Object)]);
  });

  test("breaks on non-message transcript items", () => {
    const first = messageItem("assistant-1", "assistant", 2_000);
    const thinking: ThinkingItem = {
      kind: "thinking",
      key: "thinking",
      active: true,
    };
    const second = messageItem("assistant-2", "assistant", 5_000);
    const session = membership();
    const result = project({
      items: [first, thinking, second],
      memberships: {
        "assistant-1": session,
        "assistant-2": session,
      },
    });

    expect(result.map((item) => item.kind)).toEqual([
      "sessionGroup",
      "thinking",
      "sessionGroup",
    ]);
  });

  test.each([
    ["missing summary", undefined, membership()],
    [
      "other conversation",
      completedSummary({ conversationId: "conv-other" }),
      membership(),
    ],
    [
      "different summary mode",
      completedSummary({ mode: "computer_use" }),
      membership(),
    ],
  ] as const)("leaves rows flat for %s", (_name, summary, member) => {
    const item = messageItem("assistant-1", "assistant", 2_000);
    const summaries = summary ? new Map([[summary.id, summary]]) : new Map();
    const result = groupSessionItems({
      items: [item],
      conversationId: CONVERSATION_ID,
      summariesById: summaries,
      getModeSession: () => member,
    });
    expect(result).toEqual([item]);
  });
});

test("merged aliases satisfy persisted boundaries", () => {
  const first = messageItem("display-1", "assistant", 2_000, {
    mergedMessageIds: ["assistant-1"],
  });
  const last = messageItem("display-2", "assistant", 5_000, {
    mergedMessageIds: ["assistant-2"],
  });
  const session = membership();
  const result = project({
    items: [first, last],
    memberships: { "display-1": session, "display-2": session },
  });
  const segment = expectSegment(result[0]!);

  expect(segment.containsFirstBoundary).toBe(true);
  expect(segment.containsLastBoundary).toBe(true);
  expect(segment.memberMessageIds).toEqual([
    "display-1",
    "assistant-1",
    "display-2",
    "assistant-2",
  ]);
});

test("uses preserved activity bounds from merged session members", () => {
  const merged = messageItem("display-1", "assistant", 3_000, {
    mergedMessageIds: ["assistant-1", "assistant-2"],
  });
  const session = membership();
  const result = groupSessionItems({
    items: [merged],
    conversationId: CONVERSATION_ID,
    summariesById: new Map([[SESSION_ID, completedSummary()]]),
    getModeSession: () => session,
    getActivityBounds: () => ({
      firstActivityAt: 1_000,
      lastActivityAt: 5_000,
    }),
  });
  const segment = expectSegment(result[0]!);

  expect(segment.firstActivityAt).toBe(1_000);
  expect(segment.lastActivityAt).toBe(5_000);
});

test("retains segment identity when an older same-session page is prepended", () => {
  const older = messageItem("assistant-1", "assistant", 2_000);
  const current = messageItem("assistant-2", "assistant", 5_000);
  const session = membership();
  const summariesById = new Map([[SESSION_ID, completedSummary()]]);
  const getModeSession = () => session;
  const initial = groupSessionItems({
    items: [current],
    conversationId: CONVERSATION_ID,
    summariesById,
    getModeSession,
  });
  const initialSegment = expectSegment(initial[0]!);

  const prepended = groupSessionItems({
    items: [older, current],
    conversationId: CONVERSATION_ID,
    summariesById,
    getModeSession,
    previousSegments: [initialSegment],
  });
  const prependedSegment = expectSegment(prepended[0]!);

  expect(prependedSegment.items).toEqual([older, current]);
  expect(prependedSegment.key).toBe(initialSegment.key);
});

test("reuses a previous segment key at most once when a segment splits", () => {
  const first = messageItem("assistant-1", "assistant", 2_000);
  const second = messageItem("assistant-2", "assistant", 5_000);
  const unrelated = messageItem("other", "assistant", 4_000);
  const session = membership();
  const summariesById = new Map([[SESSION_ID, completedSummary()]]);
  const getModeSession = (message: DisplayMessage) =>
    message.id === "other" ? null : session;
  const initial = groupSessionItems({
    items: [first, second],
    conversationId: CONVERSATION_ID,
    summariesById,
    getModeSession,
  });
  const initialSegment = expectSegment(initial[0]!);

  const split = groupSessionItems({
    items: [first, unrelated, second],
    conversationId: CONVERSATION_ID,
    summariesById,
    getModeSession,
    previousSegments: [initialSegment],
  });

  expect(split.map((item) => item.key)).toEqual([
    initialSegment.key,
    unrelated.key,
    `session-group:${SESSION_ID}:assistant-2`,
  ]);
});
