import { beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../../__tests__/helpers/mock-logger.js";

mock.module("../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

import {
  createComment,
  getComment,
  listComments,
} from "../../documents/document-comments-store.js";
import { initializeDb } from "../../memory/db-init.js";
import { rawRun, resetTestTables } from "../../memory/raw-query.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import {
  executeCommentList,
  executeCommentReply,
  executeCommentResolve,
} from "./document-comment-tool.js";

initializeDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SURFACE_ID = "doc-comment-tool-test";
const CONVERSATION_ID = "conv-comment-tool";

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/tmp/project",
    conversationId: CONVERSATION_ID,
    trustClass: "trusted_contact",
    executionChannel: "slack",
    ...overrides,
  };
}

function parseResult<T>(result: ToolExecutionResult): T {
  return JSON.parse(result.content) as T;
}

function seedDocument(
  surfaceId: string = SURFACE_ID,
  conversationId: string = CONVERSATION_ID,
): void {
  const now = Date.now();
  rawRun(
    /*sql*/ `INSERT OR IGNORE INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)`,
    conversationId,
    now,
    now,
  );
  rawRun(
    /*sql*/ `INSERT OR IGNORE INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at)
     VALUES (?, ?, 'Test Doc', 'body', 2, ?, ?)`,
    surfaceId,
    conversationId,
    now,
    now,
  );
  rawRun(
    /*sql*/ `INSERT OR IGNORE INTO document_conversations (surface_id, conversation_id, created_at) VALUES (?, ?, ?)`,
    surfaceId,
    conversationId,
    now,
  );
}

beforeEach(() => {
  resetTestTables(
    "document_comments",
    "document_conversations",
    "documents",
    "conversations",
  );
  seedDocument();
});

// ---------------------------------------------------------------------------
// comment_list
// ---------------------------------------------------------------------------

describe("executeCommentList", () => {
  test("returns only open comments", () => {
    const c1 = createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Open comment",
    });
    const c2 = createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Resolved comment",
    });
    // Resolve one directly via the store
    rawRun(
      /*sql*/ `UPDATE document_comments SET status = 'resolved', resolved_by = 'user1', resolved_at = ? WHERE id = ?`,
      Date.now(),
      c2.id,
    );

    const result = executeCommentList(
      { surface_id: SURFACE_ID },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const body = parseResult<{
      success: boolean;
      comments: Array<{ id: string; content: string }>;
    }>(result);
    expect(body.success).toBe(true);
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].id).toBe(c1.id);
    expect(body.comments[0].content).toBe("Open comment");
  });

  test("includes anchor and thread metadata", () => {
    const parent = createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Fix this",
      anchorStart: 5,
      anchorEnd: 10,
      anchorText: "hello",
    });
    createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "assistant",
      content: "Will do",
      parentCommentId: parent.id,
    });

    const result = executeCommentList(
      { surface_id: SURFACE_ID },
      makeContext(),
    );
    const body = parseResult<{
      comments: Array<{
        anchor_start: number | null;
        anchor_end: number | null;
        anchor_text: string | null;
        parent_comment_id: string | null;
      }>;
    }>(result);

    expect(body.comments).toHaveLength(2);
    expect(body.comments[0].anchor_start).toBe(5);
    expect(body.comments[0].anchor_end).toBe(10);
    expect(body.comments[0].anchor_text).toBe("hello");
    expect(body.comments[0].parent_comment_id).toBeNull();
    expect(body.comments[1].parent_comment_id).toBe(parent.id);
  });

  test("blocks access for non-privileged actors on other conversations", () => {
    seedDocument("doc-other", "conv-other");
    createComment({
      surfaceId: "doc-other",
      conversationId: "conv-other",
      author: "user1",
      content: "Secret feedback",
    });

    const result = executeCommentList(
      { surface_id: "doc-other" },
      makeContext({ conversationId: CONVERSATION_ID }),
    );

    expect(result.isError).toBe(true);
    expect(parseResult<{ error: string }>(result).error).toBe(
      "Document not found",
    );
  });

  test("allows guardian access to comments on any document", () => {
    seedDocument("doc-other", "conv-other");
    createComment({
      surfaceId: "doc-other",
      conversationId: "conv-other",
      author: "user1",
      content: "Cross-conv comment",
    });

    const result = executeCommentList(
      { surface_id: "doc-other" },
      makeContext({ trustClass: "guardian" }),
    );

    expect(result.isError).toBe(false);
    const body = parseResult<{ comments: Array<{ content: string }> }>(result);
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].content).toBe("Cross-conv comment");
  });
});

// ---------------------------------------------------------------------------
// comment_resolve
// ---------------------------------------------------------------------------

describe("executeCommentResolve", () => {
  test("resolves a comment with resolved_by: 'assistant' and emits SSE event", () => {
    const c = createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Fix this",
    });

    const sent: Array<{ type: string; [key: string]: unknown }> = [];
    const result = executeCommentResolve(
      { surface_id: SURFACE_ID, comment_id: c.id },
      makeContext({ sendToClient: (msg) => sent.push(msg) }),
    );

    expect(result.isError).toBe(false);
    const body = parseResult<{ success: boolean; comment_id: string }>(result);
    expect(body.success).toBe(true);
    expect(body.comment_id).toBe(c.id);

    // Verify the DB was updated
    const fetched = getComment(c.id);
    expect(fetched!.status).toBe("resolved");
    expect(fetched!.resolvedBy).toBe("assistant");

    // Verify SSE event
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("document_comment_resolved");
    expect(sent[0].commentId).toBe(c.id);
    expect(sent[0].resolvedBy).toBe("assistant");
  });

  test("returns error for non-existent comment", () => {
    const result = executeCommentResolve(
      { surface_id: SURFACE_ID, comment_id: "comment-nonexistent" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(parseResult<{ error: string }>(result).error).toBe(
      "Comment not found",
    );
  });

  test("blocks cross-conversation resolve for non-privileged actors", () => {
    seedDocument("doc-other", "conv-other");
    const c = createComment({
      surfaceId: "doc-other",
      conversationId: "conv-other",
      author: "user1",
      content: "Cannot resolve this",
    });

    const result = executeCommentResolve(
      { surface_id: "doc-other", comment_id: c.id },
      makeContext({ conversationId: CONVERSATION_ID }),
    );

    expect(result.isError).toBe(true);
    expect(parseResult<{ error: string }>(result).error).toBe(
      "Document not found",
    );
    // Comment should remain open
    expect(getComment(c.id)!.status).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// comment_reply
// ---------------------------------------------------------------------------

describe("executeCommentReply", () => {
  test("creates a reply with parent_comment_id and author: 'assistant'", () => {
    const parent = createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Please explain",
    });

    const sent: Array<{ type: string; [key: string]: unknown }> = [];
    const result = executeCommentReply(
      {
        surface_id: SURFACE_ID,
        comment_id: parent.id,
        content: "Here is my explanation",
      },
      makeContext({ sendToClient: (msg) => sent.push(msg) }),
    );

    expect(result.isError).toBe(false);
    const body = parseResult<{
      success: boolean;
      comment: {
        id: string;
        author: string;
        content: string;
        parent_comment_id: string;
      };
    }>(result);
    expect(body.success).toBe(true);
    expect(body.comment.author).toBe("assistant");
    expect(body.comment.content).toBe("Here is my explanation");
    expect(body.comment.parent_comment_id).toBe(parent.id);

    // Verify persisted in DB
    const fetched = getComment(body.comment.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.author).toBe("assistant");
    expect(fetched!.parentCommentId).toBe(parent.id);

    // Verify SSE event
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("document_comment_created");
    const eventComment = (sent[0] as unknown as { comment: { id: string } })
      .comment;
    expect(eventComment.id).toBe(body.comment.id);
  });

  test("blocks cross-conversation reply for non-privileged actors", () => {
    seedDocument("doc-other", "conv-other");
    const parent = createComment({
      surfaceId: "doc-other",
      conversationId: "conv-other",
      author: "user1",
      content: "Feedback on other doc",
    });

    const result = executeCommentReply(
      {
        surface_id: "doc-other",
        comment_id: parent.id,
        content: "Sneaky reply",
      },
      makeContext({ conversationId: CONVERSATION_ID }),
    );

    expect(result.isError).toBe(true);
    expect(parseResult<{ error: string }>(result).error).toBe(
      "Document not found",
    );
    // No reply should exist
    const comments = listComments("doc-other");
    expect(comments).toHaveLength(1);
  });

  test("works without sendToClient (no SSE emission)", () => {
    const parent = createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Question",
    });

    const result = executeCommentReply(
      {
        surface_id: SURFACE_ID,
        comment_id: parent.id,
        content: "Answer",
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const body = parseResult<{
      success: boolean;
      comment: { content: string };
    }>(result);
    expect(body.success).toBe(true);
    expect(body.comment.content).toBe("Answer");
  });
});
