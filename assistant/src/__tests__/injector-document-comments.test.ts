import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { CommentRecord } from "../documents/document-comments-store.js";

let listCommentsMock = mock((..._args: unknown[]) => [] as CommentRecord[]);

mock.module("../documents/document-comments-store.js", () => ({
  listComments: (...args: unknown[]) => listCommentsMock(...args),
}));

const { DEFAULT_INJECTOR_ORDER, defaultInjectors } =
  await import("../plugins/defaults/memory-retrieval/injectors.js");
import type { Injector, TurnContext } from "../plugins/types.js";

function findInjector(name: string): Injector {
  const injector = defaultInjectors.find(
    (candidate) => candidate.name === name,
  );
  if (!injector) {
    throw new Error(`injector '${name}' not registered`);
  }
  return injector;
}

function makeContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    requestId: "req-test",
    conversationId: "conv-test",
    turnIndex: 0,
    trust: { sourceChannel: "vellum", trustClass: "guardian" },
    ...overrides,
  };
}

function makeComment(overrides: Partial<CommentRecord> = {}): CommentRecord {
  return {
    id: "comment-abc",
    surfaceId: "doc-1",
    conversationId: "conv-test",
    author: "user",
    content: "Fix this paragraph",
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

const injector = findInjector("document-comments");

describe("document-comments injector", () => {
  beforeEach(() => {
    listCommentsMock = mock(() => [] as CommentRecord[]);
  });

  test("returns null when no active documents exist", async () => {
    const block = await injector.produce(
      makeContext({
        mode: "full",
        activeDocuments: [],
      }),
    );
    expect(block).toBeNull();
  });

  test("returns null when activeDocuments is undefined", async () => {
    const block = await injector.produce(
      makeContext({
        mode: "full",
      }),
    );
    expect(block).toBeNull();
  });

  test("returns null when mode is minimal", async () => {
    const block = await injector.produce(
      makeContext({
        mode: "minimal",
        activeDocuments: [
          {
            surfaceId: "doc-1",
            title: "My Doc",
            wordCount: 100,
            updatedAt: 1000,
          },
        ],
      }),
    );
    expect(block).toBeNull();
  });

  test("returns null when no documents have open comments", async () => {
    listCommentsMock = mock(() => []);
    const block = await injector.produce(
      makeContext({
        mode: "full",
        activeDocuments: [
          {
            surfaceId: "doc-1",
            title: "My Doc",
            wordCount: 100,
            updatedAt: 1000,
          },
        ],
      }),
    );
    expect(block).toBeNull();
  });

  test("formats doc-level comments correctly", async () => {
    listCommentsMock = mock(() => [
      makeComment({
        id: "comment-id1",
        content: "This introduction needs more context",
        anchorText: null,
      }),
    ]);

    const block = await injector.produce(
      makeContext({
        mode: "full",
        activeDocuments: [
          {
            surfaceId: "doc-1",
            title: "My Doc",
            wordCount: 100,
            updatedAt: 1000,
          },
        ],
      }),
    );

    expect(block).not.toBeNull();
    expect(block!.id).toBe("document-comments");
    expect(block!.placement).toBe("prepend-user-tail");
    expect(block!.text).toContain("(doc-level)");
    expect(block!.text).toContain("Comment #comment-id1");
    expect(block!.text).toContain('"This introduction needs more context"');
  });

  test("formats inline comments with anchor text", async () => {
    listCommentsMock = mock(() => [
      makeComment({
        id: "comment-id2",
        content: "Cite the research paper",
        anchorText: "the quick brown fox",
        anchorStart: 10,
        anchorEnd: 29,
      }),
    ]);

    const block = await injector.produce(
      makeContext({
        mode: "full",
        activeDocuments: [
          {
            surfaceId: "doc-1",
            title: "My Doc",
            wordCount: 100,
            updatedAt: 1000,
          },
        ],
      }),
    );

    expect(block).not.toBeNull();
    expect(block!.text).toContain('inline, anchored to "the quick brown fox"');
    expect(block!.text).toContain("Comment #comment-id2");
    expect(block!.text).toContain('"Cite the research paper"');
  });

  test("mixes doc-level and inline comments for the same document", async () => {
    listCommentsMock = mock(() => [
      makeComment({
        id: "comment-id1",
        content: "This introduction needs more context",
        anchorText: null,
      }),
      makeComment({
        id: "comment-id2",
        content: "Cite the research paper",
        anchorText: "the quick brown fox",
        anchorStart: 10,
        anchorEnd: 29,
      }),
    ]);

    const block = await injector.produce(
      makeContext({
        mode: "full",
        activeDocuments: [
          {
            surfaceId: "doc-xxx",
            title: "Title",
            wordCount: 200,
            updatedAt: 1000,
          },
        ],
      }),
    );

    expect(block).not.toBeNull();
    expect(block!.text).toContain('Document: "Title" (surface_id: "doc-xxx")');
    expect(block!.text).toContain(
      '- Comment #comment-id1 (doc-level): "This introduction needs more context"',
    );
    expect(block!.text).toContain(
      '- Comment #comment-id2 (inline, anchored to "the quick brown fox"): "Cite the research paper"',
    );
  });

  test("respects the 10-comment cap per document", async () => {
    const comments = Array.from({ length: 15 }, (_, i) =>
      makeComment({
        id: `comment-${i}`,
        content: `Comment number ${i}`,
        createdAt: 1000 + i,
      }),
    );
    listCommentsMock = mock(() => comments);

    const block = await injector.produce(
      makeContext({
        mode: "full",
        activeDocuments: [
          {
            surfaceId: "doc-1",
            title: "Big Doc",
            wordCount: 500,
            updatedAt: 1000,
          },
        ],
      }),
    );

    expect(block).not.toBeNull();
    // The store returns ASC order; .slice(-10) takes the 10 most recent
    for (let i = 5; i < 15; i++) {
      expect(block!.text).toContain(`Comment #comment-${i}`);
    }
    // Earlier comments should be excluded (use exact line match to avoid
    // substring collisions like "comment-1" matching "comment-10")
    for (let i = 0; i < 5; i++) {
      expect(block!.text).not.toContain(`Comment #comment-${i} (`);
    }
  });

  test("handles multiple documents with comments", async () => {
    let callCount = 0;
    listCommentsMock = mock(() => {
      callCount++;
      if (callCount === 1) {
        return [makeComment({ id: "c1", content: "Fix typo" })];
      }
      return [
        makeComment({
          id: "c2",
          content: "Add citation",
          anchorText: "some text",
          anchorStart: 0,
          anchorEnd: 9,
        }),
      ];
    });

    const block = await injector.produce(
      makeContext({
        mode: "full",
        activeDocuments: [
          {
            surfaceId: "doc-1",
            title: "Doc A",
            wordCount: 100,
            updatedAt: 1000,
          },
          {
            surfaceId: "doc-2",
            title: "Doc B",
            wordCount: 200,
            updatedAt: 2000,
          },
        ],
      }),
    );

    expect(block).not.toBeNull();
    expect(block!.text).toContain('Document: "Doc A" (surface_id: "doc-1")');
    expect(block!.text).toContain('Document: "Doc B" (surface_id: "doc-2")');
    expect(block!.text).toContain("Comment #c1");
    expect(block!.text).toContain("Comment #c2");
  });

  test("skips documents with zero open comments", async () => {
    let callCount = 0;
    listCommentsMock = mock(() => {
      callCount++;
      if (callCount === 1) return [];
      return [makeComment({ id: "c1", content: "Needs work" })];
    });

    const block = await injector.produce(
      makeContext({
        mode: "full",
        activeDocuments: [
          {
            surfaceId: "doc-1",
            title: "Empty Doc",
            wordCount: 100,
            updatedAt: 1000,
          },
          {
            surfaceId: "doc-2",
            title: "Commented Doc",
            wordCount: 200,
            updatedAt: 2000,
          },
        ],
      }),
    );

    expect(block).not.toBeNull();
    expect(block!.text).not.toContain("Empty Doc");
    expect(block!.text).toContain("Commented Doc");
  });

  test("has the correct order value", () => {
    expect(injector.order).toBe(DEFAULT_INJECTOR_ORDER.documentComments);
    expect(injector.order).toBe(46);
  });

  test("wraps output in <document_comments> tags with instructions", async () => {
    listCommentsMock = mock(() => [
      makeComment({ id: "c1", content: "Fix this" }),
    ]);

    const block = await injector.produce(
      makeContext({
        mode: "full",
        activeDocuments: [
          {
            surfaceId: "doc-1",
            title: "My Doc",
            wordCount: 100,
            updatedAt: 1000,
          },
        ],
      }),
    );

    expect(block).not.toBeNull();
    expect(block!.text).toMatch(/^<document_comments>/);
    expect(block!.text).toMatch(/<\/document_comments>$/);
    expect(block!.text).toContain("comment_resolve");
  });
});
