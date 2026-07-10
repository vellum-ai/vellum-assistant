import { beforeEach, describe, expect, test } from "bun:test";

import { initializeDb } from "../persistence/db-init.js";
import { rawRun, resetTestTables } from "../persistence/raw-query.js";
import {
  createComment,
  deleteComment,
  getComment,
  getCommentCountForDocument,
  listComments,
  reopenComment,
  resolveComment,
} from "./document-comments-store.js";

await initializeDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SURFACE_ID = "doc-test-surface";
const CONVERSATION_ID = "conv-test-123";

/** Insert a minimal document so FK constraints are satisfied. */
function seedDocument(surfaceId: string = SURFACE_ID): void {
  const now = Date.now();
  rawRun(
    "test:seedConversation",
    /*sql*/ `INSERT OR IGNORE INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)`,
    CONVERSATION_ID,
    now,
    now,
  );
  rawRun(
    "test:seedDocument",
    /*sql*/ `INSERT OR IGNORE INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at)
     VALUES (?, ?, 'Test Doc', 'body', 2, ?, ?)`,
    surfaceId,
    CONVERSATION_ID,
    now,
    now,
  );
}

beforeEach(() => {
  resetTestTables("document_comments", "documents", "conversations");
  seedDocument();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createComment", () => {
  test("creates a comment and returns the record", () => {
    const comment = createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Looks good!",
    });

    expect(comment.id).toMatch(/^comment-/);
    expect(comment.surfaceId).toBe(SURFACE_ID);
    expect(comment.conversationId).toBe(CONVERSATION_ID);
    expect(comment.author).toBe("user1");
    expect(comment.content).toBe("Looks good!");
    expect(comment.status).toBe("open");
    expect(comment.parentCommentId).toBeNull();
    expect(comment.anchorStart).toBeNull();
    expect(comment.resolvedBy).toBeNull();
    expect(comment.resolvedAt).toBeNull();
  });

  test("creates a comment with anchor data", () => {
    const comment = createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Fix this typo",
      anchorStart: 10,
      anchorEnd: 15,
      anchorText: "wrold",
    });

    expect(comment.anchorStart).toBe(10);
    expect(comment.anchorEnd).toBe(15);
    expect(comment.anchorText).toBe("wrold");
  });
});

describe("getComment", () => {
  test("returns a comment by id", () => {
    const created = createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Hello",
    });

    const fetched = getComment(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.content).toBe("Hello");
  });

  test("returns null for non-existent id", () => {
    expect(getComment("comment-nonexistent")).toBeNull();
  });
});

describe("listComments", () => {
  test("lists all comments for a surface ordered by created_at ASC", () => {
    createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "First",
    });
    createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Second",
    });

    const comments = listComments(SURFACE_ID);
    expect(comments).toHaveLength(2);
    expect(comments[0].content).toBe("First");
    expect(comments[1].content).toBe("Second");
  });

  test("filters by status=open", () => {
    const c = createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Open one",
    });
    createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Resolved one",
    });
    resolveComment(c.id, "user1");

    const open = listComments(SURFACE_ID, { status: "open" });
    expect(open).toHaveLength(1);
    expect(open[0].content).toBe("Resolved one");

    const resolved = listComments(SURFACE_ID, { status: "resolved" });
    expect(resolved).toHaveLength(1);
    expect(resolved[0].content).toBe("Open one");
  });

  test("filters topLevelOnly (excludes replies)", () => {
    const parent = createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Top-level",
    });
    createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Reply",
      parentCommentId: parent.id,
    });

    const topLevel = listComments(SURFACE_ID, { topLevelOnly: true });
    expect(topLevel).toHaveLength(1);
    expect(topLevel[0].content).toBe("Top-level");

    const all = listComments(SURFACE_ID);
    expect(all).toHaveLength(2);
  });

  test("returns empty array for unknown surface", () => {
    expect(listComments("nonexistent-surface")).toHaveLength(0);
  });
});

describe("resolveComment", () => {
  test("sets resolved fields", () => {
    const c = createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Fix this",
    });

    const result = resolveComment(c.id, "user1");
    expect(result).toBe(true);

    const fetched = getComment(c.id);
    expect(fetched!.status).toBe("resolved");
    expect(fetched!.resolvedBy).toBe("user1");
    expect(fetched!.resolvedAt).toBeGreaterThan(0);
    expect(fetched!.updatedAt).toBeGreaterThanOrEqual(c.updatedAt);
  });

  test("returns false for non-existent comment", () => {
    expect(resolveComment("comment-nonexistent", "user1")).toBe(false);
  });
});

describe("reopenComment", () => {
  test("clears resolved fields", () => {
    const c = createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Fix this",
    });
    resolveComment(c.id, "user1");

    const result = reopenComment(c.id);
    expect(result).toBe(true);

    const fetched = getComment(c.id);
    expect(fetched!.status).toBe("open");
    expect(fetched!.resolvedBy).toBeNull();
    expect(fetched!.resolvedAt).toBeNull();
  });

  test("returns false for non-existent comment", () => {
    expect(reopenComment("comment-nonexistent")).toBe(false);
  });
});

describe("deleteComment", () => {
  test("deletes a comment", () => {
    const c = createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Delete me",
    });

    expect(deleteComment(c.id)).toBe(true);
    expect(getComment(c.id)).toBeNull();
  });

  test("returns false for non-existent comment", () => {
    expect(deleteComment("comment-nonexistent")).toBe(false);
  });

  test("cascades to child replies", () => {
    const parent = createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Parent",
    });
    const reply = createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Reply",
      parentCommentId: parent.id,
    });

    expect(deleteComment(parent.id)).toBe(true);
    expect(getComment(parent.id)).toBeNull();
    expect(getComment(reply.id)).toBeNull();
  });
});

describe("getCommentCountForDocument", () => {
  test("counts only open comments", () => {
    const c = createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Open",
    });
    createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Also open",
    });

    expect(getCommentCountForDocument(SURFACE_ID)).toBe(2);

    resolveComment(c.id, "user1");
    expect(getCommentCountForDocument(SURFACE_ID)).toBe(1);
  });

  test("returns 0 for surface with no comments", () => {
    expect(getCommentCountForDocument(SURFACE_ID)).toBe(0);
  });
});

describe("thread support", () => {
  test("reply has parent_comment_id set", () => {
    const parent = createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Parent",
    });
    const reply = createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Reply",
      parentCommentId: parent.id,
    });

    const fetched = getComment(reply.id);
    expect(fetched!.parentCommentId).toBe(parent.id);
  });
});

describe("cascade on document delete", () => {
  test("deleting a document removes its comments", () => {
    createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Will be cascaded",
    });

    expect(listComments(SURFACE_ID)).toHaveLength(1);

    // Delete the document — FK cascade should remove comments.
    rawRun(
      "test:deleteDocument",
      /*sql*/ `DELETE FROM documents WHERE surface_id = ?`,
      SURFACE_ID,
    );

    expect(listComments(SURFACE_ID)).toHaveLength(0);
  });
});
