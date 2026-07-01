import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { writeSlackMetadata } from "../messaging/providers/slack/message-metadata.js";
import type { MessageLexicalSearchResult } from "../persistence/embeddings/messages-lexical-index.js";

// Mutable stand-in for the Qdrant lexical candidate helper. The default
// throws so any qdrant-path test that forgets to set an implementation fails
// loudly rather than silently exercising an empty candidate set. FTS-path
// tests never reach it (fts5 is used until the backfill completes), so its
// value is irrelevant there.
let lexicalMockImpl: (
  query: string,
  limit: number,
  opts?: { conversationId?: string },
) => Promise<MessageLexicalSearchResult[]> = () => {
  throw new Error("searchMessageIdsLexical mock not configured for this test");
};

// Records the arguments of every mock invocation so tests can assert the
// candidate over-fetch count the qdrant branch requests.
let lexicalCalls: Array<{
  query: string;
  limit: number;
  opts?: { conversationId?: string };
}> = [];

mock.module("../persistence/conversation-search-lexical.js", () => ({
  searchMessageIdsLexical: (
    query: string,
    limit: number,
    opts?: { conversationId?: string },
  ) => {
    lexicalCalls.push({ query, limit, opts });
    return lexicalMockImpl(query, limit, opts);
  },
}));

// Drives the real recall backend gate: when true the source must fall back to
// FTS regardless of the flag, because the lexical index write path is
// suppressed and Qdrant is never populated. Defaults false so every other test
// exercises its intended backend. Spread the real module so the other 9 exports
// (job handlers, enqueue helpers) stay intact for transitive importers.
let suppressIndexing = false;
const realLexicalModule =
  await import("../plugins/defaults/memory/job-handlers/index-message-lexical.js");
mock.module(
  "../plugins/defaults/memory/job-handlers/index-message-lexical.js",
  () => ({
    ...realLexicalModule,
    isMemoryIndexingSuppressed: () => suppressIndexing,
  }),
);

import {
  deleteMemoryCheckpoint,
  LEXICAL_BACKFILL_COMPLETE_KEY,
  setMemoryCheckpoint,
} from "../persistence/checkpoints.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { rawRun } from "../persistence/raw-query.js";
import { searchConversationSource } from "../plugins/defaults/memory/context-search/sources/conversations.js";
import type { RecallSearchContext } from "../plugins/defaults/memory/context-search/types.js";
await initializeDb();

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

  test("excludes legacy private conversations as defense-in-depth", async () => {
    const visible = await seedConversation({
      title: "Visible conversation",
      content: "privatetoken belongs to a normal conversation.",
    });
    const legacyPrivate = await seedConversation({
      title: "Legacy private conversation",
      content: "privatetoken belongs to legacy private history.",
    });
    rawRun(
      "UPDATE conversations SET conversation_type = 'private' WHERE id = ?",
      legacyPrivate.conversation.id,
    );

    const result = await searchConversationSource(
      "privatetoken",
      makeContext(),
      10,
    );

    expect(result.evidence.map((item) => item.locator)).toEqual([
      `${visible.conversation.id}#${visible.message.id}`,
    ]);
  });

  test("excludes legacy private conversations through the LIKE fallback", async () => {
    const visible = await seedConversation({
      title: "Visible non-ASCII conversation",
      content: "東京 appears in a normal conversation.",
    });
    const legacyPrivate = await seedConversation({
      title: "Legacy private non-ASCII conversation",
      content: "東京 appears in a private conversation.",
    });
    rawRun(
      "UPDATE conversations SET conversation_type = 'private' WHERE id = ?",
      legacyPrivate.conversation.id,
    );

    const result = await searchConversationSource("東京", makeContext(), 10);

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

  test("preserves external_content boundaries in recall evidence", async () => {
    const { conversation, message } = await seedConversation({
      title: "Slack recall",
      content:
        '<external_content source="slack" origin="@alice">\nThe recalltoken decision came from Slack.\n</external_content>',
    });

    const result = await searchConversationSource(
      "recalltoken",
      makeContext(),
      1,
    );

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      locator: `${conversation.id}#${message.id}`,
      excerpt:
        '<external_content source="slack" origin="@alice">\nThe recalltoken decision came from Slack.\n</external_content>',
    });
  });

  test("wraps raw non-guardian Slack recall evidence from metadata", async () => {
    const { conversation, message } = await seedConversation({
      title: "Raw Slack recall",
      role: "user",
      content: "The rawrecalltoken decision came from Slack.",
      metadata: slackMetadata("1700000100.000000", {
        provenanceTrustClass: "unknown",
      }),
    });

    const result = await searchConversationSource(
      "rawrecalltoken",
      makeContext(),
      1,
    );

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      locator: `${conversation.id}#${message.id}`,
      excerpt:
        '<external_content source="slack" origin="@alice">\nThe rawrecalltoken decision came from Slack.\n</external_content>',
    });
  });

  test("wraps raw non-guardian Slack recall evidence that mentions external_content", async () => {
    const { conversation, message } = await seedConversation({
      title: "Raw Slack tag mention recall",
      role: "user",
      content:
        "The tagmentionrecalltoken text mentions <external_content but is raw Slack content.",
      metadata: slackMetadata("1700000102.000000", {
        provenanceTrustClass: "unknown",
      }),
    });

    const result = await searchConversationSource(
      "tagmentionrecalltoken",
      makeContext(),
      1,
    );

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      locator: `${conversation.id}#${message.id}`,
      excerpt:
        '<external_content source="slack" origin="@alice">\nThe tagmentionrecalltoken text mentions <external_content but is raw Slack content.\n</external_content>',
    });
  });

  test("does not wrap guardian Slack recall evidence", async () => {
    const { conversation, message } = await seedConversation({
      title: "Guardian Slack recall",
      role: "user",
      content: "The guardianrecalltoken decision came from Slack.",
      metadata: slackMetadata("1700000101.000000", {
        provenanceTrustClass: "guardian",
      }),
    });

    const result = await searchConversationSource(
      "guardianrecalltoken",
      makeContext(),
      1,
    );

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      locator: `${conversation.id}#${message.id}`,
      excerpt: "The guardianrecalltoken decision came from Slack.",
    });
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

describe("searchConversationSource with the qdrant backend", () => {
  beforeEach(() => {
    getDb().run("DELETE FROM messages");
    getDb().run("DELETE FROM conversations");
    lexicalCalls = [];
    suppressIndexing = false;
    // The qdrant backend is selected once the index is populated: not suppressed
    // + backfill complete. These tests exercise that post-backfill path, so mark
    // the backfill complete. The completion gate is covered by its own test.
    setMemoryCheckpoint(LEXICAL_BACKFILL_COMPLETE_KEY, "1");
  });

  afterEach(() => {
    suppressIndexing = false;
    deleteMemoryCheckpoint(LEXICAL_BACKFILL_COMPLETE_KEY);
    lexicalMockImpl = () => {
      throw new Error(
        "searchMessageIdsLexical mock not configured for this test",
      );
    };
  });

  test("falls back to FTS when memory indexing is suppressed", async () => {
    const match = await seedConversation({
      title: "Suppressed indexing notes",
      content: "The suppressedtoken decision is recorded here.",
    });

    // The lexical index is not populated while indexing is suppressed, so the
    // source must NOT query Qdrant — it must use the FTS path.
    suppressIndexing = true;
    lexicalMockImpl = async () => {
      throw new Error("searchMessageIdsLexical must not run while suppressed");
    };

    const result = await searchConversationSource(
      "suppressedtoken",
      makeContext(),
      5,
    );

    // FTS path found the row (proves the backend fell back), and the Qdrant
    // candidate helper was never called.
    expect(lexicalCalls).toHaveLength(0);
    expect(result.evidence.map((item) => item.locator)).toEqual([
      `${match.conversation.id}#${match.message.id}`,
    ]);
  });

  test("falls back to FTS until the backfill completion checkpoint is set", async () => {
    const match = await seedConversation({
      title: "Pre-backfill notes",
      content: "The prebackfilltoken decision is recorded here.",
    });

    // On an upgraded instance the historical messages are still being indexed
    // by the background backfill, so the lexical collection is only partially
    // populated. Until the completion checkpoint is set, the source must use
    // the FTS path and never query Qdrant.
    deleteMemoryCheckpoint(LEXICAL_BACKFILL_COMPLETE_KEY);
    lexicalMockImpl = async () => {
      throw new Error(
        "searchMessageIdsLexical must not run before the backfill completes",
      );
    };

    const result = await searchConversationSource(
      "prebackfilltoken",
      makeContext(),
      5,
    );

    expect(lexicalCalls).toHaveLength(0);
    expect(result.evidence.map((item) => item.locator)).toEqual([
      `${match.conversation.id}#${match.message.id}`,
    ]);
  });

  test("routes short/punctuation-only queries to the exact LIKE path, not Qdrant", async () => {
    const match = await seedConversation({
      title: "C++ notes",
      role: "user",
      content: "Use C++ when the example needs deterministic lifetime notes.",
    });

    // `C++` produces no usable ≥2-char FTS match shape, so the source must use
    // the exact LIKE path rather than the sparse encoder (which would still
    // emit a noisy 1-char `c` token). The mock throws to prove it never runs.
    lexicalMockImpl = async () => {
      throw new Error("searchMessageIdsLexical must not run for a short query");
    };

    const result = await searchConversationSource("C++", makeContext(), 5);

    expect(lexicalCalls).toHaveLength(0);
    expect(result.evidence.map((item) => item.locator)).toEqual([
      `${match.conversation.id}#${match.message.id}`,
    ]);
  });

  test("over-fetches a wide candidate pool from Qdrant, not the FTS prefetch window", async () => {
    const match = await seedConversation({
      title: "Launch notes",
      content: "The widecandidatetoken launch checklist is recorded here.",
    });

    lexicalMockImpl = async () => [{ messageId: match.message.id, score: 0.9 }];

    // limit = 5 → FTS would prefetch 5 × 5 = 25. The qdrant branch instead
    // over-fetches max(5 × 20, 200) = 200 candidates so post-filter yield stays
    // healthy when top lexical hits are excluded by the SQL predicates.
    const result = await searchConversationSource(
      "widecandidatetoken",
      makeContext(),
      5,
    );

    expect(lexicalCalls).toHaveLength(1);
    expect(lexicalCalls[0]?.limit).toBe(200);
    // Filtering still yields the correctly-scored surviving row.
    expect(result.evidence.map((item) => item.locator)).toEqual([
      `${match.conversation.id}#${match.message.id}`,
    ]);
    expect(result.evidence[0]?.score).toBeGreaterThan(0);
  });

  test("returns app-scored evidence for Qdrant-supplied candidates", async () => {
    const match = await seedConversation({
      title: "Launch notes",
      content: "The alpha launch checklist includes database backups.",
    });
    // A candidate the lexical index also surfaces but that the query does not
    // actually match — proves the app-side scorer, not Qdrant order, ranks.
    const weak = await seedConversation({
      title: "Unrelated",
      content: "Nothing salient in this conversation at all.",
    });

    lexicalMockImpl = async () => [
      { messageId: weak.message.id, score: 0.9 },
      { messageId: match.message.id, score: 0.1 },
    ];

    const result = await searchConversationSource(
      "alpha launch",
      makeContext(),
      5,
    );

    expect(result.evidence[0]).toMatchObject({
      id: `conversations:${match.conversation.id}:${match.message.id}`,
      source: "conversations",
      title: "Launch notes",
      locator: `${match.conversation.id}#${match.message.id}`,
      excerpt: "The alpha launch checklist includes database backups.",
      metadata: {
        role: "assistant",
        conversationId: match.conversation.id,
      },
    });
    expect(result.evidence[0]?.score).toBeGreaterThan(
      result.evidence[1]?.score ?? -1,
    );
  });

  test("applies source, type, and excluded-conversation filters to Qdrant candidates", async () => {
    const visible = await seedConversation({
      title: "User conversation",
      content: "derivedtoken belongs to a user-authored conversation.",
    });
    const subagent = await seedConversation({
      title: "Subagent conversation",
      source: "subagent",
      content: "derivedtoken should not include subagent output.",
    });
    const autoAnalysis = await seedConversation({
      title: "Auto-analysis conversation",
      source: "auto-analysis",
      content: "derivedtoken should not include auto-analysis output.",
    });
    const notification = await seedConversation({
      title: "Notification conversation",
      source: "notification",
      content: "derivedtoken should not include notification output.",
    });
    const current = await seedConversation({
      title: "Current conversation",
      content: "derivedtoken appears in the active conversation.",
    });
    const legacyPrivate = await seedConversation({
      title: "Legacy private conversation",
      content: "derivedtoken belongs to legacy private history.",
    });
    rawRun(
      "UPDATE conversations SET conversation_type = 'private' WHERE id = ?",
      legacyPrivate.conversation.id,
    );

    // The lexical index does not filter — it hands back every candidate,
    // including the ones SQL must exclude.
    lexicalMockImpl = async () => [
      { messageId: visible.message.id, score: 0.9 },
      { messageId: subagent.message.id, score: 0.85 },
      { messageId: autoAnalysis.message.id, score: 0.8 },
      { messageId: notification.message.id, score: 0.75 },
      { messageId: current.message.id, score: 0.7 },
      { messageId: legacyPrivate.message.id, score: 0.65 },
    ];

    const result = await searchConversationSource(
      "derivedtoken",
      makeContext({ conversationId: current.conversation.id }),
      10,
    );

    expect(result.evidence.map((item) => item.locator)).toEqual([
      `${visible.conversation.id}#${visible.message.id}`,
    ]);
  });

  test("falls back to LIKE when the Qdrant lookup throws", async () => {
    const match = await seedConversation({
      title: "Fallback notes",
      content: "The likefallbacktoken decision is recorded here.",
    });

    lexicalMockImpl = async () => {
      throw new Error("qdrant unavailable");
    };

    const result = await searchConversationSource(
      "likefallbacktoken",
      makeContext(),
      5,
    );

    expect(result.evidence.map((item) => item.locator)).toEqual([
      `${match.conversation.id}#${match.message.id}`,
    ]);
  });

  test("falls back to LIKE when Qdrant returns no candidates", async () => {
    const match = await seedConversation({
      title: "Empty candidate notes",
      content: "The emptycandidatetoken decision is recorded here.",
    });

    lexicalMockImpl = async () => [];

    const result = await searchConversationSource(
      "emptycandidatetoken",
      makeContext(),
      5,
    );

    expect(result.evidence.map((item) => item.locator)).toEqual([
      `${match.conversation.id}#${match.message.id}`,
    ]);
  });
});

function seedConversation(opts: {
  title?: string;
  conversationType?: "standard" | "background" | "scheduled";
  source?: string;
  memoryScopeId?: string;
  role?: string;
  content: string;
  metadata?: string;
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
      created_at,
      metadata
    ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    message.id,
    conversation.id,
    opts.role ?? "assistant",
    opts.content,
    now,
    opts.metadata ?? null,
  );

  return { conversation, message };
}

function slackMetadata(
  channelTs: string,
  extra: Record<string, unknown>,
): string {
  return JSON.stringify({
    userMessageChannel: "slack",
    assistantMessageChannel: "slack",
    slackMeta: writeSlackMetadata({
      source: "slack",
      channelId: "C0123",
      channelTs,
      eventKind: "message",
      displayName: "@alice",
    }),
    ...extra,
  });
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
