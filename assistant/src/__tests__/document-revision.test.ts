/**
 * Every document write bumps `revision`, read-modify-write paths retry instead
 * of losing a concurrent write, and `POST documents` with `baseRevision`
 * rejects a save made against a stale revision.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import {
  createDocument,
  getDocumentById,
  getDocumentsForConversation,
  listAllDocuments,
  mutateDocumentContent,
  replaceInDocument,
  saveDocument,
  updateDocumentContent,
} from "../documents/document-store.js";
import { createConversation } from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { ROUTES as DOCUMENT_ROUTES } from "../runtime/routes/documents-routes.js";
import { ConflictError } from "../runtime/routes/errors.js";
import type { RouteDefinition } from "../runtime/routes/types.js";
import {
  executeDocumentCreate,
  executeDocumentOpen,
  executeDocumentReplaceText,
  executeDocumentUpdate,
} from "../tools/document/document-tool.js";
import type { ToolContext } from "../tools/types.js";
import { resetDbForTesting } from "./db-test-helpers.js";

await initializeDb();

const CONVERSATION_ID = "conv-doc-revision";

function route(operationId: string): RouteDefinition {
  return DOCUMENT_ROUTES.find((r) => r.operationId === operationId)!;
}

async function post(body: Record<string, unknown>): Promise<unknown> {
  return await route("saveDocument").handler({ body });
}

function seed(content = "one"): string {
  const created = createDocument({
    conversationId: CONVERSATION_ID,
    title: "Doc",
    content,
  });
  if (!created.success) {
    throw new Error(created.error);
  }
  return created.surfaceId;
}

function revisionOf(surfaceId: string): number {
  return getDocumentById(surfaceId)!.revision;
}

type SentMessage = { type: string; [key: string]: unknown };

function makeContext(sent: SentMessage[]): ToolContext {
  return {
    workingDir: "/tmp/project",
    conversationId: CONVERSATION_ID,
    trustClass: "guardian",
    executionChannel: "vellum",
    sendToClient: (message) => {
      sent.push(message);
    },
  };
}

beforeEach(() => {
  const db = getDb();
  db.run("DELETE FROM document_conversations");
  db.run("DELETE FROM documents");
  db.run("DELETE FROM conversations");
  createConversation({ id: CONVERSATION_ID });
});

afterAll(() => {
  resetDbForTesting();
});

describe("revision counter", () => {
  test("a new document starts at revision 1", () => {
    expect(revisionOf(seed())).toBe(1);
  });

  test("every write path bumps the revision by one", () => {
    const surfaceId = seed("alpha");

    saveDocument({
      surfaceId,
      conversationId: CONVERSATION_ID,
      title: "Doc",
      content: "beta",
      wordCount: 1,
    });
    expect(revisionOf(surfaceId)).toBe(2);

    updateDocumentContent(surfaceId, "gamma", "append");
    expect(revisionOf(surfaceId)).toBe(3);

    updateDocumentContent(surfaceId, "delta", "replace");
    expect(revisionOf(surfaceId)).toBe(4);

    replaceInDocument(surfaceId, "delta", "epsilon");
    expect(revisionOf(surfaceId)).toBe(5);
    expect(getDocumentById(surfaceId)?.content).toBe("epsilon");
  });

  test("a replace that matches nothing writes nothing", () => {
    const surfaceId = seed("alpha");

    const result = replaceInDocument(surfaceId, "missing", "x");

    expect(result).toMatchObject({
      success: true,
      content_changed: false,
      revision: 1,
    });
    expect(revisionOf(surfaceId)).toBe(1);
  });

  test("list and read projections carry the revision", () => {
    const surfaceId = seed();
    updateDocumentContent(surfaceId, "two", "append");

    expect(getDocumentsForConversation(CONVERSATION_ID)[0]?.revision).toBe(2);
    expect(listAllDocuments()[0]?.revision).toBe(2);
  });
});

describe("conditional save", () => {
  test("writes when baseRevision matches", () => {
    const surfaceId = seed("alpha");

    const result = saveDocument({
      surfaceId,
      conversationId: CONVERSATION_ID,
      title: "Doc",
      content: "beta",
      wordCount: 1,
      baseRevision: 1,
    });

    expect(result).toEqual({ success: true, surfaceId, revision: 2 });
    expect(getDocumentById(surfaceId)?.content).toBe("beta");
  });

  test("rejects a stale baseRevision without writing", () => {
    const surfaceId = seed("alpha");
    updateDocumentContent(surfaceId, "assistant edit", "replace");

    const result = saveDocument({
      surfaceId,
      conversationId: CONVERSATION_ID,
      title: "Stale title",
      content: "stale body",
      wordCount: 2,
      baseRevision: 1,
    });

    expect(result).toMatchObject({
      success: false,
      conflict: { revision: 2, title: "Doc", content: "assistant edit" },
    });
    expect(getDocumentById(surfaceId)).toMatchObject({
      title: "Doc",
      content: "assistant edit",
      revision: 2,
    });
  });

  test("creates a document that does not exist yet", () => {
    const result = saveDocument({
      surfaceId: "doc-new",
      conversationId: CONVERSATION_ID,
      title: "New",
      content: "body",
      wordCount: 1,
      baseRevision: 0,
    });

    expect(result).toEqual({
      success: true,
      surfaceId: "doc-new",
      revision: 1,
    });
  });
});

describe("read-modify-write under interleaving", () => {
  test("a write landing between the read and the write is kept", () => {
    const surfaceId = seed("base");
    let calls = 0;

    const outcome = mutateDocumentContent(surfaceId, "assistant", (current) => {
      calls++;
      if (calls === 1) {
        // Another writer lands after this attempt read the row.
        saveDocument({
          surfaceId,
          conversationId: CONVERSATION_ID,
          title: "Doc",
          content: "base\n\nuser edit",
          wordCount: 3,
        });
      }
      return { content: `${current.content}\n\nappended`, value: calls };
    });

    expect(calls).toBe(2);
    expect(outcome).toEqual({
      value: 2,
      content: "base\n\nuser edit\n\nappended",
      revision: 3,
    });
    expect(getDocumentById(surfaceId)?.content).toBe(
      "base\n\nuser edit\n\nappended",
    );
  });

  test("gives up after repeated losses instead of overwriting", () => {
    const surfaceId = seed("base");
    let calls = 0;

    expect(() =>
      mutateDocumentContent(surfaceId, "assistant", (current) => {
        calls++;
        saveDocument({
          surfaceId,
          conversationId: CONVERSATION_ID,
          title: "Doc",
          content: `interloper ${calls}`,
          wordCount: 2,
        });
        return { content: `${current.content} mine`, value: null };
      }),
    ).toThrow(/kept changing/);
    expect(getDocumentById(surfaceId)?.content).toBe(`interloper ${calls}`);
  });

  test("returns null for a missing document", () => {
    expect(
      mutateDocumentContent("doc-missing", "assistant", () => ({
        value: null,
      })),
    ).toBeNull();
  });
});

describe("POST documents", () => {
  test("without baseRevision the write is unconditional", async () => {
    const surfaceId = seed("alpha");
    updateDocumentContent(surfaceId, "assistant edit", "replace");

    const result = await post({
      surfaceId,
      conversationId: CONVERSATION_ID,
      title: "Doc",
      content: "legacy client body",
      wordCount: 3,
    });

    expect(result).toEqual({ success: true, surfaceId, revision: 3 });
    expect(getDocumentById(surfaceId)?.content).toBe("legacy client body");
  });

  test("a null baseRevision is treated as omitted", async () => {
    const surfaceId = seed("alpha");
    updateDocumentContent(surfaceId, "assistant edit", "replace");

    await expect(
      post({
        surfaceId,
        conversationId: CONVERSATION_ID,
        title: "Doc",
        content: "body",
        wordCount: 1,
        baseRevision: null,
      }),
    ).resolves.toMatchObject({ success: true, revision: 3 });
  });

  test("a matching baseRevision saves and returns the new revision", async () => {
    const surfaceId = seed("alpha");

    await expect(
      post({
        surfaceId,
        conversationId: CONVERSATION_ID,
        title: "Doc",
        content: "beta",
        wordCount: 1,
        baseRevision: 1,
      }),
    ).resolves.toEqual({ success: true, surfaceId, revision: 2 });
  });

  test("a stale baseRevision is a 409 carrying the current state", async () => {
    const surfaceId = seed("alpha");
    updateDocumentContent(surfaceId, "assistant edit", "replace");

    const error = await post({
      surfaceId,
      conversationId: CONVERSATION_ID,
      title: "Doc",
      content: "stale",
      wordCount: 1,
      baseRevision: 1,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).statusCode).toBe(409);
    expect((error as ConflictError).details).toEqual({
      revision: 2,
      title: "Doc",
      content: "assistant edit",
    });
    expect(getDocumentById(surfaceId)?.content).toBe("assistant edit");
  });

  test("rejects a malformed baseRevision", async () => {
    const surfaceId = seed();
    for (const baseRevision of [-1, 1.5, "1"]) {
      await expect(
        post({
          surfaceId,
          conversationId: CONVERSATION_ID,
          title: "Doc",
          content: "x",
          wordCount: 1,
          baseRevision,
        }),
      ).rejects.toThrow(/baseRevision must be a non-negative integer/);
    }
  });

  test("GET documents/:id includes the revision", async () => {
    const surfaceId = seed();
    expect(
      await route("getDocument").handler({ pathParams: { id: surfaceId } }),
    ).toMatchObject({ surfaceId, revision: 1 });
  });

  test("list items include the revision", async () => {
    const surfaceId = seed();
    const result = (await route("listDocuments").handler({})) as {
      documents: Array<{ surfaceId: string; revision: number }>;
    };
    expect(result.documents).toEqual([
      expect.objectContaining({ surfaceId, revision: 1 }),
    ]);
  });
});

describe("editor events carry the revision", () => {
  test("document_create shows the editor at revision 1", () => {
    const sent: SentMessage[] = [];
    executeDocumentCreate(
      { title: "Plan", initial_content: "hello" },
      makeContext(sent),
    );

    expect(sent.find((m) => m.type === "document_editor_show")).toMatchObject({
      initialContent: "hello",
      revision: 1,
    });
  });

  test("document_open shows the stored revision", () => {
    const surfaceId = seed();
    updateDocumentContent(surfaceId, "more", "append");
    const sent: SentMessage[] = [];

    executeDocumentOpen({ surface_id: surfaceId }, makeContext(sent));

    expect(sent.find((m) => m.type === "document_editor_show")).toMatchObject({
      surfaceId,
      revision: 2,
    });
  });

  test("document_update sends the revision after the write", () => {
    const surfaceId = seed();
    const sent: SentMessage[] = [];

    executeDocumentUpdate(
      { surface_id: surfaceId, content: "two", mode: "append" },
      makeContext(sent),
    );

    expect(sent).toEqual([
      expect.objectContaining({
        type: "document_editor_update",
        markdown: "two",
        mode: "append",
        revision: 2,
      }),
    ]);
  });

  test("document_replace_text sends the written body and its revision", () => {
    const surfaceId = seed("hello world");
    const sent: SentMessage[] = [];

    executeDocumentReplaceText(
      { surface_id: surfaceId, find: "world", replace: "there" },
      makeContext(sent),
    );

    expect(sent).toEqual([
      expect.objectContaining({
        type: "document_editor_update",
        markdown: "hello there",
        mode: "replace",
        revision: 2,
      }),
    ]);
  });
});
