import { beforeEach, describe, expect, test } from "bun:test";

import { searchConversationSource } from "../memory/context-search/sources/conversations.js";
import type { RecallSearchContext } from "../memory/context-search/types.js";
import { addMessage, createConversation } from "../memory/conversation-crud.js";
import { getDb, initializeDb, rawRun } from "../memory/db.js";

initializeDb();

describe("searchConversationSource", () => {
  beforeEach(() => {
    getDb().run("DELETE FROM messages");
    getDb().run("DELETE FROM conversations");
  });

  test("returns matching message evidence through the FTS path", async () => {
    const conversation = createConversation("Launch notes");
    const message = await addMessage(
      conversation.id,
      "assistant",
      "The alpha launch checklist includes database backups.",
      undefined,
      { skipIndexing: true },
    );

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
    const shortConversation = createConversation("C++ notes");
    await addMessage(
      shortConversation.id,
      "user",
      "Use C++ when the example needs deterministic lifetime notes.",
      undefined,
      { skipIndexing: true },
    );
    const unicodeConversation = createConversation("Unicode notes");
    await addMessage(
      unicodeConversation.id,
      "assistant",
      "The keyword 東京 appears in this conversation.",
      undefined,
      { skipIndexing: true },
    );

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

  test("filters results to the requested memory scope", async () => {
    const inScope = await seedConversation({
      title: "In-scope conversation",
      memoryScopeId: "scope-a",
      content: "sharedtoken belongs to scope A.",
    });
    await seedConversation({
      title: "Out-of-scope conversation",
      memoryScopeId: "scope-b",
      content: "sharedtoken belongs to scope B.",
    });

    const result = await searchConversationSource(
      "sharedtoken",
      makeContext({ memoryScopeId: "scope-a" }),
      10,
    );

    expect(result.evidence.map((item) => item.locator)).toEqual([
      `${inScope.conversation.id}#${inScope.message.id}`,
    ]);
  });

  test("does not return derived subagent or auto-analysis conversations", async () => {
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

    const result = await searchConversationSource(
      "derivedtoken",
      makeContext(),
      10,
    );

    expect(result.evidence.map((item) => item.locator)).toEqual([
      `${visible.conversation.id}#${visible.message.id}`,
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
});

async function seedConversation(opts: {
  title?: string;
  conversationType?: "standard" | "background" | "scheduled";
  source?: string;
  memoryScopeId?: string;
  content: string;
}) {
  const conversation = createConversation({
    title: opts.title,
    conversationType: opts.conversationType,
    source: opts.source,
  });
  if (opts.memoryScopeId) {
    rawRun(
      "UPDATE conversations SET memory_scope_id = ? WHERE id = ?",
      opts.memoryScopeId,
      conversation.id,
    );
  }
  const message = await addMessage(
    conversation.id,
    "assistant",
    opts.content,
    undefined,
    { skipIndexing: true },
  );

  return { conversation, message };
}

function makeContext(
  overrides: Partial<RecallSearchContext> = {},
): RecallSearchContext {
  return {
    workingDir: "/tmp/example-workspace",
    memoryScopeId: "default",
    conversationId: "current-conversation",
    config: {} as RecallSearchContext["config"],
    ...overrides,
  };
}
