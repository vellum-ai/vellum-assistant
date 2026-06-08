import { describe, expect, mock, test } from "bun:test";

import type {
  DocumentCommentCreatedEvent,
  DocumentCommentDeletedEvent,
  DocumentCommentReopenedEvent,
  DocumentCommentResolvedEvent,
} from "@vellumai/assistant-api";
import type { DocumentsByIdCommentsPostResponse } from "@/generated/daemon/types.gen";
import {
  type CommentStateMap,
  type DocumentCommentEventCallbacks,
  handleDocumentCommentCreated,
  handleDocumentCommentDeleted,
  handleDocumentCommentReopened,
  handleDocumentCommentResolved,
} from "@/domains/chat/api/document-comment-events";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(
  entries?: [string, DocumentsByIdCommentsPostResponse[]][],
): CommentStateMap {
  return new Map(entries ?? []);
}

function makeCallbacks(): DocumentCommentEventCallbacks & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    onCommentsChanged: mock((surfaceId: string) => {
      calls.push(surfaceId);
    }),
  };
}

function makeComment(
  overrides?: Partial<DocumentsByIdCommentsPostResponse>,
): DocumentsByIdCommentsPostResponse {
  return {
    id: "c1",
    surfaceId: "doc-1",
    conversationId: "conv-1",
    author: "user",
    content: "A comment",
    anchorStart: null,
    anchorEnd: null,
    anchorText: null,
    parentCommentId: null,
    status: "open",
    resolvedBy: null,
    resolvedAt: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// handleDocumentCommentCreated
// ---------------------------------------------------------------------------

describe("handleDocumentCommentCreated", () => {
  test("adds comment to empty state map", () => {
    const state = makeState();
    const cb = makeCallbacks();
    const event: DocumentCommentCreatedEvent = {
      type: "document_comment_created",
      conversationId: "conv-1",
      surfaceId: "doc-1",
      comment: {
        id: "c1",
        surfaceId: "doc-1",
        author: "user",
        content: "First comment",
        anchorStart: 0,
        anchorEnd: 10,
        anchorText: "hello",
        status: "open",
        createdAt: 1000,
        updatedAt: 1000,
      },
    };

    handleDocumentCommentCreated(event, state, cb);

    const comments = state.get("doc-1")!;
    expect(comments).toHaveLength(1);
    expect(comments[0]!.id).toBe("c1");
    expect(comments[0]!.content).toBe("First comment");
    expect(comments[0]!.anchorStart).toBe(0);
    expect(comments[0]!.anchorEnd).toBe(10);
    expect(comments[0]!.anchorText).toBe("hello");
    expect(comments[0]!.conversationId).toBe("conv-1");
    expect(comments[0]!.author).toBe("user");
    expect(cb.calls).toEqual(["doc-1"]);
  });

  test("appends to existing comments for same surface", () => {
    const existing = makeComment({ id: "c0" });
    const state = makeState([["doc-1", [existing]]]);
    const cb = makeCallbacks();
    const event: DocumentCommentCreatedEvent = {
      type: "document_comment_created",
      conversationId: "conv-1",
      surfaceId: "doc-1",
      comment: {
        id: "c1",
        surfaceId: "doc-1",
        author: "assistant",
        content: "Second comment",
        status: "open",
        createdAt: 2000,
        updatedAt: 2000,
      },
    };

    handleDocumentCommentCreated(event, state, cb);

    const comments = state.get("doc-1")!;
    expect(comments).toHaveLength(2);
    expect(comments[0]!.id).toBe("c0");
    expect(comments[1]!.id).toBe("c1");
    expect(comments[1]!.author).toBe("assistant");
  });

  test("normalizes optional fields to null", () => {
    const state = makeState();
    const cb = makeCallbacks();
    const event: DocumentCommentCreatedEvent = {
      type: "document_comment_created",
      conversationId: "conv-1",
      surfaceId: "doc-1",
      comment: {
        id: "c1",
        surfaceId: "doc-1",
        author: "user",
        content: "No anchor",
        status: "open",
        createdAt: 1000,
        updatedAt: 1000,
      },
    };

    handleDocumentCommentCreated(event, state, cb);

    const comment = state.get("doc-1")![0]!;
    expect(comment.anchorStart).toBeNull();
    expect(comment.anchorEnd).toBeNull();
    expect(comment.anchorText).toBeNull();
    expect(comment.parentCommentId).toBeNull();
    expect(comment.resolvedBy).toBeNull();
    expect(comment.resolvedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleDocumentCommentResolved
// ---------------------------------------------------------------------------

describe("handleDocumentCommentResolved", () => {
  test("updates comment status to resolved", () => {
    const comment = makeComment({ id: "c1", status: "open" });
    const state = makeState([["doc-1", [comment]]]);
    const cb = makeCallbacks();
    const event: DocumentCommentResolvedEvent = {
      type: "document_comment_resolved",
      conversationId: "conv-1",
      surfaceId: "doc-1",
      commentId: "c1",
      resolvedBy: "user-123",
    };

    handleDocumentCommentResolved(event, state, cb);

    expect(comment.status).toBe("resolved");
    expect(comment.resolvedBy).toBe("user-123");
    expect(comment.resolvedAt).toBeGreaterThan(0);
    expect(cb.calls).toEqual(["doc-1"]);
  });

  test("no-ops when surface has no comments", () => {
    const state = makeState();
    const cb = makeCallbacks();
    const event: DocumentCommentResolvedEvent = {
      type: "document_comment_resolved",
      conversationId: "conv-1",
      surfaceId: "doc-1",
      commentId: "c1",
      resolvedBy: "user-123",
    };

    handleDocumentCommentResolved(event, state, cb);

    expect(cb.calls).toHaveLength(0);
  });

  test("no-ops when comment id not found", () => {
    const comment = makeComment({ id: "c2" });
    const state = makeState([["doc-1", [comment]]]);
    const cb = makeCallbacks();
    const event: DocumentCommentResolvedEvent = {
      type: "document_comment_resolved",
      conversationId: "conv-1",
      surfaceId: "doc-1",
      commentId: "c999",
      resolvedBy: "user-123",
    };

    handleDocumentCommentResolved(event, state, cb);

    expect(comment.status).toBe("open");
    expect(cb.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleDocumentCommentReopened
// ---------------------------------------------------------------------------

describe("handleDocumentCommentReopened", () => {
  test("updates comment status to open", () => {
    const comment = makeComment({
      id: "c1",
      status: "resolved",
      resolvedBy: "user-123",
      resolvedAt: 2000,
    });
    const state = makeState([["doc-1", [comment]]]);
    const cb = makeCallbacks();
    const event: DocumentCommentReopenedEvent = {
      type: "document_comment_reopened",
      conversationId: "conv-1",
      surfaceId: "doc-1",
      commentId: "c1",
    };

    handleDocumentCommentReopened(event, state, cb);

    expect(comment.status).toBe("open");
    expect(comment.resolvedBy).toBeNull();
    expect(comment.resolvedAt).toBeNull();
    expect(cb.calls).toEqual(["doc-1"]);
  });

  test("no-ops when surface has no comments", () => {
    const state = makeState();
    const cb = makeCallbacks();
    const event: DocumentCommentReopenedEvent = {
      type: "document_comment_reopened",
      conversationId: "conv-1",
      surfaceId: "doc-1",
      commentId: "c1",
    };

    handleDocumentCommentReopened(event, state, cb);

    expect(cb.calls).toHaveLength(0);
  });

  test("no-ops when comment id not found", () => {
    const comment = makeComment({ id: "c2", status: "resolved" });
    const state = makeState([["doc-1", [comment]]]);
    const cb = makeCallbacks();
    const event: DocumentCommentReopenedEvent = {
      type: "document_comment_reopened",
      conversationId: "conv-1",
      surfaceId: "doc-1",
      commentId: "c999",
    };

    handleDocumentCommentReopened(event, state, cb);

    expect(comment.status).toBe("resolved");
    expect(cb.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleDocumentCommentDeleted
// ---------------------------------------------------------------------------

describe("handleDocumentCommentDeleted", () => {
  test("removes comment from state", () => {
    const comment = makeComment({ id: "c1" });
    const other = makeComment({ id: "c2" });
    const state = makeState([["doc-1", [comment, other]]]);
    const cb = makeCallbacks();
    const event: DocumentCommentDeletedEvent = {
      type: "document_comment_deleted",
      conversationId: "conv-1",
      surfaceId: "doc-1",
      commentId: "c1",
    };

    handleDocumentCommentDeleted(event, state, cb);

    const comments = state.get("doc-1")!;
    expect(comments).toHaveLength(1);
    expect(comments[0]!.id).toBe("c2");
    expect(cb.calls).toEqual(["doc-1"]);
  });

  test("removes surface entry when last comment is deleted", () => {
    const comment = makeComment({ id: "c1" });
    const state = makeState([["doc-1", [comment]]]);
    const cb = makeCallbacks();
    const event: DocumentCommentDeletedEvent = {
      type: "document_comment_deleted",
      conversationId: "conv-1",
      surfaceId: "doc-1",
      commentId: "c1",
    };

    handleDocumentCommentDeleted(event, state, cb);

    expect(state.has("doc-1")).toBe(false);
    expect(cb.calls).toEqual(["doc-1"]);
  });

  test("no-ops when surface has no comments", () => {
    const state = makeState();
    const cb = makeCallbacks();
    const event: DocumentCommentDeletedEvent = {
      type: "document_comment_deleted",
      conversationId: "conv-1",
      surfaceId: "doc-1",
      commentId: "c1",
    };

    handleDocumentCommentDeleted(event, state, cb);

    expect(cb.calls).toHaveLength(0);
  });

  test("no-ops when comment id not found", () => {
    const comment = makeComment({ id: "c2" });
    const state = makeState([["doc-1", [comment]]]);
    const cb = makeCallbacks();
    const event: DocumentCommentDeletedEvent = {
      type: "document_comment_deleted",
      conversationId: "conv-1",
      surfaceId: "doc-1",
      commentId: "c999",
    };

    handleDocumentCommentDeleted(event, state, cb);

    const comments = state.get("doc-1")!;
    expect(comments).toHaveLength(1);
    expect(cb.calls).toHaveLength(0);
  });
});
