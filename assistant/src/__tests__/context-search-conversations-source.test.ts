import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { writeSlackMetadata } from "../messaging/providers/slack/message-metadata.js";
import type { MessageLexicalSearchResult } from "../persistence/embeddings/messages-lexical-index.js";

// Mutable stand-in for the Qdrant lexical candidate helper. The source treats
// a thrown lookup as "no candidates" (logged, empty evidence), so the throwing
// default cannot fail a forgetful test loudly — tests that assert evidence
// must configure an implementation, and tests that assert the helper is never
// consulted check `lexicalCalls` instead.
let lexicalMockImpl: (
  query: string,
  limit: number,
  opts?: { conversationId?: string },
) => Promise<MessageLexicalSearchResult[]> = () => {
  throw new Error("searchMessageIdsLexical mock not configured for this test");
};

// Records the arguments of every mock invocation so tests can assert the
// candidate over-fetch count and that gated paths never consult the index.
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

// Drives the real recall availability gate: when true the source yields no
// evidence, because the lexical index write path is suppressed and the
// collection is never populated. Defaults false so every other test exercises
// the live path. Spread the real module so its other exports (job handlers,
// enqueue helpers) stay intact for transitive importers.
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

describe("searchConversationSource (qdrant lexical index)", () => {
  beforeEach(() => {
    getDb().run("DELETE FROM messages");
    getDb().run("DELETE FROM conversations");
    lexicalCalls = [];
    suppressIndexing = false;
    // Content evidence is available once the index is populated: not
    // suppressed + backfill complete. Most tests exercise that path, so mark
    // the backfill complete; the gates are covered by their own tests.
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

  test("returns matching message evidence for lexical candidates", async () => {
    const { conversation, message } = await seedConversation({
      title: "Launch notes",
      content: "The alpha launch checklist includes database backups.",
    });

    lexicalMockImpl = async () => [{ messageId: message.id, score: 0.9 }];

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

  test("returns no evidence for short and non-ASCII queries (content matching is index-only)", async () => {
    // Short/punctuation-only and CJK queries produce no usable ≥2-char token.
    // There is no content-scan fallback, so such queries yield no conversation
    // evidence even when an exact substring exists — and the index is never
    // consulted (the sparse encoder would emit noisy 1-char tokens).
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

    expect(lexicalCalls).toHaveLength(0);
    expect(shortResult.evidence).toEqual([]);
    expect(unicodeResult.evidence).toEqual([]);
  });

  test("returns no evidence when memory indexing is suppressed", async () => {
    await seedConversation({
      title: "Suppressed indexing notes",
      content: "The suppressedtoken decision is recorded here.",
    });

    // The lexical index is never populated while indexing is suppressed, so
    // the source must yield no evidence without consulting Qdrant.
    suppressIndexing = true;
    lexicalMockImpl = async () => {
      throw new Error("searchMessageIdsLexical must not run while suppressed");
    };

    const result = await searchConversationSource(
      "suppressedtoken",
      makeContext(),
      5,
    );

    expect(lexicalCalls).toHaveLength(0);
    expect(result.evidence).toEqual([]);
  });

  test("returns no evidence until the backfill completion checkpoint is set", async () => {
    await seedConversation({
      title: "Pre-backfill notes",
      content: "The prebackfilltoken decision is recorded here.",
    });

    // On an upgraded instance the historical messages are still being indexed
    // by the background backfill, so the lexical collection is only partially
    // populated. Until the completion checkpoint is set, the source must
    // yield no evidence without consulting Qdrant.
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
    expect(result.evidence).toEqual([]);
  });

  test("over-fetches a wide candidate pool from Qdrant", async () => {
    const match = await seedConversation({
      title: "Launch notes",
      content: "The widecandidatetoken launch checklist is recorded here.",
    });

    lexicalMockImpl = async () => [{ messageId: match.message.id, score: 0.9 }];

    // limit = 5 → the source over-fetches max(5 × 20, 200) = 200 candidates so
    // post-filter yield stays healthy when top lexical hits are excluded by
    // the SQL predicates.
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

    lexicalMockImpl = async () => [
      { messageId: archived.message.id, score: 0.9 },
      { messageId: scheduled.message.id, score: 0.85 },
      { messageId: background.message.id, score: 0.8 },
    ];

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

    lexicalMockImpl = async () => [{ messageId: message.id, score: 0.9 }];

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

    lexicalMockImpl = async () => [{ messageId: message.id, score: 0.9 }];

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

    lexicalMockImpl = async () => [{ messageId: message.id, score: 0.9 }];

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

    lexicalMockImpl = async () => [{ messageId: message.id, score: 0.9 }];

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

    lexicalMockImpl = async () => [{ messageId: message.id, score: 0.9 }];

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

  test("returns no evidence when the Qdrant lookup throws", async () => {
    await seedConversation({
      title: "Failure notes",
      content: "The qdranterrortoken decision is recorded here.",
    });

    lexicalMockImpl = async () => {
      throw new Error("qdrant unavailable");
    };

    const result = await searchConversationSource(
      "qdranterrortoken",
      makeContext(),
      5,
    );

    // Content matching is index-only: the failure is logged and the source
    // yields no conversation evidence — no content-scan recovery.
    expect(result.evidence).toEqual([]);
  });

  test("returns no evidence when Qdrant returns no candidates", async () => {
    await seedConversation({
      title: "Empty candidate notes",
      content: "The emptycandidatetoken decision is recorded here.",
    });

    lexicalMockImpl = async () => [];

    const result = await searchConversationSource(
      "emptycandidatetoken",
      makeContext(),
      5,
    );

    // The index is authoritative for content matching — an empty candidate
    // set is an empty result, not a trigger for a table-scan fallback.
    expect(result.evidence).toEqual([]);
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
