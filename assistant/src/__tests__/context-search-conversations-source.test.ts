import { beforeEach, describe, expect, test } from "bun:test";

import { searchConversationSource } from "../memory/context-search/sources/conversations.js";
import type { RecallSearchContext } from "../memory/context-search/types.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { rawRun } from "../memory/raw-query.js";
initializeDb();

let seedId = 0;

describe("searchConversationSource", () => {
  beforeEach(() => {
    getDb().run("DELETE FROM messages");
    getDb().run("DELETE FROM conversations");
  });

  test("returns matching message evidence through the FTS path", async () => {
    const { conversation, message } = await seedConversation({
      title: "Launch notes",
      content: "The alpha launch checklist includes database backups.",
    });

    const result = await searchConversationSource(
      "alpha launch",
      makeContext(),
      5,
    );

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      id: `conversations:${conversation.id}:${message.id}`,
      source: "conversations",
      title: "Launch notes",
      locator: `${conversation.id}#${message.id}`,
      excerpt: "The alpha launch checklist includes database backups.",
      timestampMs: message.createdAt,
      metadata: {
        role: "assistant",
        conversationId: conversation.id,
      },
    });
  });

  test("uses LIKE fallback for short and non-ASCII queries", async () => {
    await seedConversation({
      title: "C++ notes",
      role: "user",
      content: "Use C++ when the example needs deterministic lifetime notes.",
    });
    await seedConversation({
      title: "Unicode notes",
      content: "The keyword 東京 appears in this conversation.",
    });

    const shortResult = await searchConversationSource("C++", makeContext(), 5);
    const unicodeResult = await searchConversationSource(
      "東京",
      makeContext(),
      5,
    );

    expect(shortResult.evidence.map((item) => item.title)).toEqual([
      "C++ notes",
    ]);
    expect(unicodeResult.evidence.map((item) => item.title)).toEqual([
      "Unicode notes",
    ]);
  });

  test("does not return derived subagent, auto-analysis, or notification conversations", async () => {
    const visible = await seedConversation({
      title: "User conversation",
      content: "derivedtoken belongs to a user-authored conversation.",
    });
    await seedConversation({
      title: "Subagent conversation",
      source: "subagent",
      content: "derivedtoken should not include subagent output.",
    });
    await seedConversation({
      title: "Auto-analysis conversation",
      source: "auto-analysis",
      content: "derivedtoken should not include auto-analysis output.",
    });
    await seedConversation({
      title: "Notification conversation",
      source: "notification",
      content: "derivedtoken should not include notification seed output.",
    });

    const result = await searchConversationSource(
      "derivedtoken",
      makeContext(),
      10,
    );

    expect(result.evidence.map((item) => item.locator)).toEqual([
      `${visible.conversation.id}#${visible.message.id}`,
    ]);
  });

  test("excludes the current conversation from recall results", async () => {
    const other = await seedConversation({
      title: "Other conversation",
      content: "currenttoken appears in another conversation.",
    });
    const current = await seedConversation({
      title: "Current conversation",
      content: "currenttoken appears in the active conversation.",
    });

    const result = await searchConversationSource(
      "currenttoken",
      makeContext({ conversationId: current.conversation.id }),
      10,
    );

    expect(result.evidence.map((item) => item.locator)).toEqual([
      `${other.conversation.id}#${other.message.id}`,
    ]);
  });

  test("includes archived, scheduled, and background conversations", async () => {
    const archived = await seedConversation({
      title: "Archived conversation",
      content: "includetoken appears in archived history.",
    });
    rawRun(
      "UPDATE conversations SET archived_at = ? WHERE id = ?",
      Date.now(),
      archived.conversation.id,
    );
    const scheduled = await seedConversation({
      title: "Scheduled conversation",
      conversationType: "scheduled",
      content: "includetoken appears in scheduled history.",
    });
    const background = await seedConversation({
      title: "Background conversation",
      conversationType: "background",
      content: "includetoken appears in background history.",
    });

    const result = await searchConversationSource(
      "includetoken",
      makeContext(),
      10,
    );

    expect(new Set(result.evidence.map((item) => item.locator))).toEqual(
      new Set([
        `${archived.conversation.id}#${archived.message.id}`,
        `${scheduled.conversation.id}#${scheduled.message.id}`,
        `${background.conversation.id}#${background.message.id}`,
      ]),
    );
  });

  test("formats fallback title and excerpts from message content blocks", async () => {
    const content = JSON.stringify([
      {
        type: "text",
        text: "Before the needle marker, the useful text is inside a content block.",
      },
    ]);
    const { conversation, message } = await seedConversation({
      title: undefined,
      content,
    });

    const result = await searchConversationSource("needle", makeContext(), 1);

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].title).toBe("Untitled conversation");
    expect(result.evidence[0].locator).toBe(`${conversation.id}#${message.id}`);
    expect(result.evidence[0].excerpt).toBe(
      "Before the needle marker, the useful text is inside a content block.",
    );
  });

  test("broadens overconstrained recall queries to salient terms", async () => {
    const specific = await seedConversation({
      title: "Birthday cake plan",
      content:
        "The birthday cake was vanilla with raspberry filling and had the message Happy birthday Alice Love Example Assistant.",
    });
    await seedConversation({
      title: "Decoration notes",
      content: "The decoration and flavor notes for the launch party are open.",
    });

    const result = await searchConversationSource(
      "birthday cake flavor decoration message recipient",
      makeContext(),
      5,
    );

    expect(result.evidence[0]).toMatchObject({
      locator: `${specific.conversation.id}#${specific.message.id}`,
      title: "Birthday cake plan",
    });
    expect(result.evidence[0]?.excerpt).toContain("vanilla with raspberry");
    expect(result.evidence[0]?.score).toBeGreaterThan(0);
  });
});

function seedConversation(opts: {
  title?: string;
  conversationType?: "standard" | "background" | "scheduled";
  source?: string;
  memoryScopeId?: string;
  role?: string;
  content: string;
}) {
  const id = ++seedId;
  const now = Date.now() + id;
  const conversation = {
    id: `test-conversation-${id}`,
    title: opts.title ?? null,
  };
  const message = {
    id: `test-message-${id}`,
    createdAt: now,
  };

  rawRun(
    `
    INSERT INTO conversations (
      id,
      title,
      created_at,
      updated_at,
      conversation_type,
      source,
      memory_scope_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    conversation.id,
    conversation.title,
    now,
    now,
    opts.conversationType ?? "standard",
    opts.source ?? "user",
    opts.memoryScopeId ?? "default",
  );
  rawRun(
    `
    INSERT INTO messages (
      id,
      conversation_id,
      role,
      content,
      created_at
    ) VALUES (?, ?, ?, ?, ?)
    `,
    message.id,
    conversation.id,
    opts.role ?? "assistant",
    opts.content,
    now,
  );

  return { conversation, message };
}

function makeContext(
  overrides: Partial<RecallSearchContext> = {},
): RecallSearchContext {
  return {
    workingDir: "/tmp/example-workspace",
    conversationId: "current-conversation",
    config: {} as RecallSearchContext["config"],
    ...overrides,
  };
}
