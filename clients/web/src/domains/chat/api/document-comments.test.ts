import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { client } from "@/generated/daemon/client.gen";
import { ApiError } from "@/utils/api-errors";

import {
  createComment,
  deleteComment,
  fetchComments,
  reopenComment,
  resolveComment,
} from "@/domains/chat/api/document-comments";

// ---------------------------------------------------------------------------
// Test helpers
//
// The generated daemon SDK functions call `client.get` / `client.post` /
// `client.patch` / `client.delete` on the daemon client, so mock those
// methods directly rather than globalThis.fetch — same pattern as
// conversation-starters.test.ts.
// ---------------------------------------------------------------------------

interface CapturedOptions {
  url: string;
  path: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  throwOnError: boolean;
}

function makeOkResult(body: unknown) {
  return {
    data: body,
    error: undefined,
    response: new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  };
}

function makeErrorResult(status: number, body: unknown) {
  return {
    data: undefined,
    error: body,
    response: new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  };
}

let originalGet: typeof client.get;
let originalPost: typeof client.post;
let originalPatch: typeof client.patch;
let originalDelete: typeof client.delete;
let capturedOptions: CapturedOptions[] = [];
let nextResult: { data: unknown; error: unknown; response: Response } | null =
  null;

function mockMethod(method: string) {
  return mock(async (options: Record<string, unknown>) => {
    capturedOptions.push({
      url: options.url as string,
      path: options.path as Record<string, string>,
      query: options.query as Record<string, string> | undefined,
      body: options.body,
      throwOnError: options.throwOnError as boolean,
    });
    if (!nextResult) {
      throw new Error(`test setup forgot to set nextResult (${method})`);
    }
    return nextResult;
  });
}

beforeEach(() => {
  originalGet = client.get;
  originalPost = client.post;
  originalPatch = client.patch;
  originalDelete = client.delete;
  capturedOptions = [];
  nextResult = null;

  const c = client as unknown as Record<string, unknown>;
  c.get = mockMethod("get");
  c.post = mockMethod("post");
  c.patch = mockMethod("patch");
  c.delete = mockMethod("delete");
});

afterEach(() => {
  const c = client as unknown as Record<string, unknown>;
  c.get = originalGet;
  c.post = originalPost;
  c.patch = originalPatch;
  c.delete = originalDelete;
});

// ---------------------------------------------------------------------------
// fetchComments
// ---------------------------------------------------------------------------

describe("fetchComments", () => {
  test("sends GET to correct URL with path params", async () => {
    nextResult = makeOkResult({ comments: [] });

    await fetchComments("asst-1", "doc-1");

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]!.url).toBe(
      "/v1/assistants/{assistant_id}/documents/{id}/comments",
    );
    expect(capturedOptions[0]!.path).toEqual({
      assistant_id: "asst-1",
      id: "doc-1",
    });
    expect(capturedOptions[0]!.throwOnError).toBe(false);
  });

  test("forwards optional status filter as query param", async () => {
    nextResult = makeOkResult({ comments: [] });

    await fetchComments("asst-1", "doc-1", "open");

    expect(capturedOptions[0]!.query).toEqual({ status: "open" });
  });

  test("omits status query param when not provided", async () => {
    nextResult = makeOkResult({ comments: [] });

    await fetchComments("asst-1", "doc-1");

    expect(capturedOptions[0]!.query).toEqual({});
  });

  test("returns comments array from response", async () => {
    const comment = {
      id: "c1",
      surfaceId: "doc-1",
      conversationId: "conv-1",
      author: "user",
      content: "Great point",
      anchorStart: 0,
      anchorEnd: 10,
      anchorText: "some text",
      parentCommentId: null,
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
      createdAt: 1000,
      updatedAt: 1000,
    };
    nextResult = makeOkResult({ comments: [comment] });

    const result = await fetchComments("asst-1", "doc-1");

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("c1");
    expect(result[0]!.content).toBe("Great point");
  });

  test("throws ApiError on non-OK response", async () => {
    nextResult = makeErrorResult(500, { detail: "internal error" });

    let caught: unknown = null;
    try {
      await fetchComments("asst-1", "doc-1");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(500);
    expect((caught as ApiError).message).toContain("internal error");
  });
});

// ---------------------------------------------------------------------------
// createComment
// ---------------------------------------------------------------------------

describe("createComment", () => {
  test("sends POST with correct body shape", async () => {
    nextResult = makeOkResult({
      id: "c1",
      surfaceId: "doc-1",
      conversationId: "conv-1",
      author: "user",
      content: "A comment",
      anchorStart: 5,
      anchorEnd: 15,
      anchorText: "highlighted",
      parentCommentId: null,
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
      createdAt: 1000,
      updatedAt: 1000,
      success: true,
    });

    await createComment("asst-1", "doc-1", {
      content: "A comment",
      conversationId: "conv-1",
      anchorStart: 5,
      anchorEnd: 15,
      anchorText: "highlighted",
    });

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]!.url).toBe(
      "/v1/assistants/{assistant_id}/documents/{id}/comments",
    );
    expect(capturedOptions[0]!.path).toEqual({
      assistant_id: "asst-1",
      id: "doc-1",
    });
    expect(capturedOptions[0]!.body).toEqual({
      content: "A comment",
      conversationId: "conv-1",
      anchorStart: 5,
      anchorEnd: 15,
      anchorText: "highlighted",
    });
    expect(capturedOptions[0]!.throwOnError).toBe(false);
  });

  test("sends POST with parentCommentId for replies", async () => {
    nextResult = makeOkResult({
      id: "c2",
      surfaceId: "doc-1",
      conversationId: "conv-1",
      author: "user",
      content: "A reply",
      anchorStart: null,
      anchorEnd: null,
      anchorText: null,
      parentCommentId: "c1",
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
      createdAt: 1000,
      updatedAt: 1000,
      success: true,
    });

    await createComment("asst-1", "doc-1", {
      content: "A reply",
      conversationId: "conv-1",
      parentCommentId: "c1",
    });

    expect(capturedOptions[0]!.body).toEqual({
      content: "A reply",
      conversationId: "conv-1",
      parentCommentId: "c1",
    });
  });

  test("returns created comment", async () => {
    const comment = {
      id: "c1",
      surfaceId: "doc-1",
      conversationId: "conv-1",
      author: "user" as const,
      content: "New comment",
      anchorStart: null,
      anchorEnd: null,
      anchorText: null,
      parentCommentId: null,
      status: "open" as const,
      resolvedBy: null,
      resolvedAt: null,
      createdAt: 1000,
      updatedAt: 1000,
      success: true,
    };
    nextResult = makeOkResult(comment);

    const result = await createComment("asst-1", "doc-1", {
      content: "New comment",
      conversationId: "conv-1",
    });

    expect(result.id).toBe("c1");
    expect(result.content).toBe("New comment");
  });

  test("throws ApiError on non-OK response", async () => {
    nextResult = makeErrorResult(400, { detail: "bad request" });

    let caught: unknown = null;
    try {
      await createComment("asst-1", "doc-1", {
        content: "",
        conversationId: "conv-1",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// resolveComment
// ---------------------------------------------------------------------------

describe("resolveComment", () => {
  test("sends PATCH with status resolved", async () => {
    nextResult = makeOkResult({
      id: "c1",
      surfaceId: "doc-1",
      conversationId: "conv-1",
      author: "user",
      content: "Resolved",
      anchorStart: null,
      anchorEnd: null,
      anchorText: null,
      parentCommentId: null,
      status: "resolved",
      resolvedBy: "user-123",
      resolvedAt: 2000,
      createdAt: 1000,
      updatedAt: 2000,
      success: true,
    });

    await resolveComment("asst-1", "doc-1", "c1");

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]!.url).toBe(
      "/v1/assistants/{assistant_id}/documents/{id}/comments/{commentId}",
    );
    expect(capturedOptions[0]!.path).toEqual({
      assistant_id: "asst-1",
      id: "doc-1",
      commentId: "c1",
    });
    expect(capturedOptions[0]!.body).toEqual({ status: "resolved" });
    expect(capturedOptions[0]!.throwOnError).toBe(false);
  });

  test("throws ApiError on non-OK response", async () => {
    nextResult = makeErrorResult(404, { detail: "not found" });

    let caught: unknown = null;
    try {
      await resolveComment("asst-1", "doc-1", "c1");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// reopenComment
// ---------------------------------------------------------------------------

describe("reopenComment", () => {
  test("sends PATCH with status open", async () => {
    nextResult = makeOkResult({
      id: "c1",
      surfaceId: "doc-1",
      conversationId: "conv-1",
      author: "user",
      content: "Reopened",
      anchorStart: null,
      anchorEnd: null,
      anchorText: null,
      parentCommentId: null,
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
      createdAt: 1000,
      updatedAt: 3000,
      success: true,
    });

    await reopenComment("asst-1", "doc-1", "c1");

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]!.url).toBe(
      "/v1/assistants/{assistant_id}/documents/{id}/comments/{commentId}",
    );
    expect(capturedOptions[0]!.path).toEqual({
      assistant_id: "asst-1",
      id: "doc-1",
      commentId: "c1",
    });
    expect(capturedOptions[0]!.body).toEqual({ status: "open" });
    expect(capturedOptions[0]!.throwOnError).toBe(false);
  });

  test("throws ApiError on non-OK response", async () => {
    nextResult = makeErrorResult(403, { detail: "forbidden" });

    let caught: unknown = null;
    try {
      await reopenComment("asst-1", "doc-1", "c1");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// deleteComment
// ---------------------------------------------------------------------------

describe("deleteComment", () => {
  test("sends DELETE with correct path params", async () => {
    nextResult = makeOkResult({ success: true });

    await deleteComment("asst-1", "doc-1", "c1");

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]!.url).toBe(
      "/v1/assistants/{assistant_id}/documents/{id}/comments/{commentId}",
    );
    expect(capturedOptions[0]!.path).toEqual({
      assistant_id: "asst-1",
      id: "doc-1",
      commentId: "c1",
    });
    expect(capturedOptions[0]!.throwOnError).toBe(false);
  });

  test("returns success from response", async () => {
    nextResult = makeOkResult({ success: true });

    const result = await deleteComment("asst-1", "doc-1", "c1");

    expect(result).toEqual({ success: true });
  });

  test("throws ApiError on non-OK response", async () => {
    nextResult = makeErrorResult(404, { detail: "comment not found" });

    let caught: unknown = null;
    try {
      await deleteComment("asst-1", "doc-1", "c1");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(404);
    expect((caught as ApiError).message).toContain("comment not found");
  });
});
