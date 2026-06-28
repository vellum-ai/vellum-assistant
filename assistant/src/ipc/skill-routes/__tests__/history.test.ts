/**
 * Tests for the `host.history.*` skill IPC routes.
 *
 * Two layers:
 *
 * 1. Route-level unit tests (mirroring `memory.test.ts`): the underlying
 *    daemon delegate is mocked, so each test exercises only the route layer —
 *    param parsing, delegate call shape, and return shape.
 * 2. A full out-of-process round-trip: a real {@link SkillHostClient} from
 *    `@vellumai/skill-host-contracts` talks to a live {@link SkillIpcServer}
 *    over a temp socket and calls `client.history.getRecentMessages(...)`,
 *    proving the client facet → IPC frame → server route → facet builder path
 *    end-to-end.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Module-level stubs — installed before importing the modules under test
// ---------------------------------------------------------------------------

interface FakeMessageRow {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: number;
  metadata: string | null;
}

const fakeConversation = {
  id: "conv-1",
  title: "Test",
  conversationType: "default",
  source: "test",
  createdAt: 1,
  updatedAt: 2,
  lastMessageAt: 3,
  archivedAt: null,
  // Extra columns the facet projection drops — present so the row resembles a
  // real ConversationRow.
  totalTokens: 0,
};

// Oldest→newest, both visible (user/assistant, not hidden).
const fakeRows: FakeMessageRow[] = [
  {
    id: "m1",
    conversationId: "conv-1",
    role: "user",
    content: "hello",
    createdAt: 10,
    metadata: null,
  },
  {
    id: "m2",
    conversationId: "conv-1",
    role: "assistant",
    content: "hi there",
    createdAt: 20,
    metadata: null,
  },
];

const getConversationSpy = mock((id: string) =>
  id === "conv-1" ? fakeConversation : null,
);

const getMessagesPaginatedSpy = mock(
  (
    _conversationId: string,
    _limit: number | undefined,
    _beforeTimestamp: number | undefined,
    filter?: (row: FakeMessageRow) => boolean,
  ) => ({
    messages: filter ? fakeRows.filter(filter) : fakeRows,
    hasMore: false,
  }),
);

mock.module("../../../persistence/conversation-crud.js", () => ({
  getConversation: getConversationSpy,
  getMessagesPaginated: getMessagesPaginatedSpy,
  // The facet module also imports `addMessage` (memory facet); provide a stub
  // so the shared module graph resolves.
  addMessage: mock(async () => ({ id: "msg-x", createdAt: 0 })),
}));

// ---------------------------------------------------------------------------
// Modules under test — imported after every stub is in place
// ---------------------------------------------------------------------------

import { SkillHostClient } from "@vellumai/skill-host-contracts";

import { SkillIpcServer } from "../../skill-server.js";
import {
  historyGetConversationRoute,
  historyGetMessagesRoute,
  historyGetRecentMessagesRoute,
  historySkillRoutes,
} from "../history.js";

beforeEach(() => {
  getConversationSpy.mockClear();
  getMessagesPaginatedSpy.mockClear();
});

describe("historySkillRoutes registry", () => {
  test("exposes the three canonical method names", () => {
    const methods = historySkillRoutes.map((r) => r.method).sort();
    expect(methods).toEqual([
      "host.history.getConversation",
      "host.history.getMessages",
      "host.history.getRecentMessages",
    ]);
  });
});

describe("host.history.getConversation (route level)", () => {
  test("returns the projected conversation header", async () => {
    const result = (await historyGetConversationRoute.handler({
      conversationId: "conv-1",
    })) as { id: string; title: string } | null;
    expect(getConversationSpy).toHaveBeenCalledTimes(1);
    expect(result?.id).toBe("conv-1");
    expect(result?.title).toBe("Test");
    // Per-turn token accounting is not part of the history projection.
    expect((result as Record<string, unknown>).totalTokens).toBeUndefined();
  });

  test("returns null for an unknown conversation", async () => {
    const result = await historyGetConversationRoute.handler({
      conversationId: "missing",
    });
    expect(result).toBeNull();
  });

  test("rejects a missing conversationId", async () => {
    await expect(historyGetConversationRoute.handler({})).rejects.toThrow();
  });
});

describe("host.history.getRecentMessages (route level)", () => {
  test("returns visible messages oldest→newest", async () => {
    const result = (await historyGetRecentMessagesRoute.handler({
      conversationId: "conv-1",
      n: 5,
    })) as Array<{ id: string; role: string; content: string }>;
    expect(getMessagesPaginatedSpy).toHaveBeenCalledTimes(1);
    expect(result.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(result[0]?.role).toBe("user");
    expect(result[1]?.role).toBe("assistant");
  });

  test("rejects a non-numeric n", async () => {
    await expect(
      historyGetRecentMessagesRoute.handler({
        conversationId: "conv-1",
        n: "lots",
      }),
    ).rejects.toThrow();
  });
});

describe("host.history.getMessages (route level)", () => {
  test("returns a page shape with hasMore", async () => {
    const result = (await historyGetMessagesRoute.handler({
      conversationId: "conv-1",
      limit: 50,
    })) as { messages: unknown[]; hasMore: boolean };
    expect(result.hasMore).toBe(false);
    expect(result.messages).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Full out-of-process round-trip via the real SkillHostClient.
// ---------------------------------------------------------------------------

describe("host.history.getRecentMessages — out-of-process round-trip", () => {
  let tempDir: string | null = null;
  let server: SkillIpcServer | null = null;
  let client: SkillHostClient | null = null;
  let savedSocketDir: string | undefined;

  beforeEach(async () => {
    savedSocketDir = process.env.ASSISTANT_SKILL_IPC_SOCKET_DIR;
    tempDir = mkdtempSync(join(tmpdir(), "history-ipc-test-"));
    process.env.ASSISTANT_SKILL_IPC_SOCKET_DIR = tempDir;
    server = new SkillIpcServer();
    await server.start();
    client = new SkillHostClient({
      socketPath: server.getSocketPath(),
      skillId: "test-skill",
    });
    // The client prefetches sync state on connect (platform/identity); those
    // routes are registered too, so connect resolves against the live server.
    await client.connect();
  });

  afterEach(async () => {
    client?.close();
    client = null;
    server?.stop();
    server = null;
    if (savedSocketDir === undefined) {
      delete process.env.ASSISTANT_SKILL_IPC_SOCKET_DIR;
    } else {
      process.env.ASSISTANT_SKILL_IPC_SOCKET_DIR = savedSocketDir;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  test("client.history.getRecentMessages returns the daemon's rows", async () => {
    const messages = await client!.history.getRecentMessages("conv-1", 5);
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(messages[0]).toMatchObject({
      id: "m1",
      conversationId: "conv-1",
      role: "user",
      content: "hello",
    });
    // The server-side delegate actually ran (the value crossed the socket).
    expect(getMessagesPaginatedSpy).toHaveBeenCalled();
  });
});

afterAll(() => {
  mock.restore();
});
