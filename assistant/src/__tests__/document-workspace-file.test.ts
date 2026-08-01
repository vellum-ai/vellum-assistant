/**
 * Tests for file-backed documents: the find-or-create route that gives a
 * workspace markdown file a document identity, and the write-through that
 * keeps the file in step with every document content write.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { getDocumentById } from "../documents/document-store.js";
import { getDb, getSqlite } from "../persistence/db-connection.js";
import { migrateAddDocumentWorkspacePath } from "../persistence/migrations/360-add-document-workspace-path.js";
import { ROUTES as DOCUMENT_ROUTES } from "../runtime/routes/documents-routes.js";
import {
  BadRequestError,
  NotFoundError,
  UnprocessableEntityError,
} from "../runtime/routes/errors.js";
import type { RouteDefinition } from "../runtime/routes/types.js";
import {
  executeDocumentReplaceText,
  executeDocumentUpdate,
} from "../tools/document/document-tool.js";
import type { ToolContext } from "../tools/types.js";
import { resetDbForTesting } from "./db-test-helpers.js";

const workspaceDir = process.env.VELLUM_WORKSPACE_DIR!;
const notesDir = join(workspaceDir, "notes");

const CONVERSATION_ID = "conv-file-docs";

interface DocumentPayload {
  success: boolean;
  surfaceId: string;
  title: string;
  content: string;
  wordCount: number;
  workspacePath: string | null;
}

function getRoute(operationId: string): RouteDefinition {
  const route = DOCUMENT_ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`No document route found for operationId: ${operationId}`);
  }
  return route;
}

/**
 * Open a workspace file as a document. Returns the route payload so callers
 * can assert on the same shape `GET documents/{id}` serves.
 */
async function openWorkspaceFile(
  path: string,
  conversationId = CONVERSATION_ID,
): Promise<DocumentPayload> {
  const route = getRoute("documentForWorkspaceFile");
  const result = await route.handler({ body: { path, conversationId } });
  return result as DocumentPayload;
}

/** Save a document through the client's document save route. */
async function saveViaRoute(
  surfaceId: string,
  title: string,
  content: string,
): Promise<void> {
  const route = getRoute("saveDocument");
  await route.handler({
    body: {
      surfaceId,
      conversationId: CONVERSATION_ID,
      title,
      content,
      wordCount: content.split(/\s+/).filter((w) => w.length > 0).length,
    },
  });
}

function makeToolContext(): ToolContext {
  return {
    workingDir: workspaceDir,
    conversationId: CONVERSATION_ID,
    trustClass: "guardian",
    executionChannel: "web",
  };
}

/**
 * Rebuild the document tables at the pre-360 shape, then apply the migration —
 * the same order a real upgrade takes, so these tests exercise the migrated
 * schema rather than a hand-written copy of it.
 */
function bootstrapDocumentTables(): void {
  resetDbForTesting();
  const raw = getSqlite();
  raw.exec(/*sql*/ `
    DROP TABLE IF EXISTS document_conversations;
    DROP TABLE IF EXISTS documents;
    DROP TABLE IF EXISTS conversations;

    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE documents (
      surface_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      word_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE document_conversations (
      surface_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (surface_id, conversation_id),
      FOREIGN KEY (surface_id) REFERENCES documents(surface_id) ON DELETE CASCADE
    );
  `);
  migrateAddDocumentWorkspacePath(getDb());
  raw
    .query(`INSERT OR IGNORE INTO conversations (id, created_at) VALUES (?, ?)`)
    .run(CONVERSATION_ID, Date.now());
  raw
    .query(`INSERT OR IGNORE INTO conversations (id, created_at) VALUES (?, ?)`)
    .run("conv-other", Date.now());
}

beforeEach(() => {
  bootstrapDocumentTables();
  rmSync(notesDir, { recursive: true, force: true });
  mkdirSync(notesDir, { recursive: true });
});

describe("POST documents/for-workspace-file", () => {
  test("creates a document seeded from the file, then returns the same one", async () => {
    writeFileSync(join(notesDir, "plan.md"), "# Plan\n\nFirst draft.");

    const first = await openWorkspaceFile("notes/plan.md");
    expect(first.success).toBe(true);
    expect(first.title).toBe("plan.md");
    expect(first.content).toBe("# Plan\n\nFirst draft.");
    expect(first.workspacePath).toBe("notes/plan.md");

    const second = await openWorkspaceFile("notes/plan.md");
    expect(second.surfaceId).toBe(first.surfaceId);

    // Non-canonical spellings of the same path resolve to the same document.
    const third = await openWorkspaceFile("./notes/../notes/plan.md");
    expect(third.surfaceId).toBe(first.surfaceId);
  });

  test("refreshes stored content from disk when the file changed underneath", async () => {
    const filePath = join(notesDir, "plan.md");
    writeFileSync(filePath, "original body");

    const first = await openWorkspaceFile("notes/plan.md");
    expect(first.content).toBe("original body");

    writeFileSync(filePath, "edited outside the editor");

    const reopened = await openWorkspaceFile("notes/plan.md");
    expect(reopened.surfaceId).toBe(first.surfaceId);
    expect(reopened.content).toBe("edited outside the editor");
    expect(reopened.wordCount).toBe(4);
    expect(getDocumentById(first.surfaceId)?.content).toBe(
      "edited outside the editor",
    );
  });

  test("associates the document with every conversation that opens it", async () => {
    writeFileSync(join(notesDir, "plan.md"), "shared");

    const first = await openWorkspaceFile("notes/plan.md");
    await openWorkspaceFile("notes/plan.md", "conv-other");

    const rows = getSqlite()
      .query(
        `SELECT conversation_id FROM document_conversations WHERE surface_id = ? ORDER BY conversation_id`,
      )
      .all(first.surfaceId) as Array<{ conversation_id: string }>;
    expect(rows.map((r) => r.conversation_id)).toEqual([
      CONVERSATION_ID,
      "conv-other",
    ]);
  });

  test("rejects paths that escape the workspace", async () => {
    await expect(openWorkspaceFile("../escape.md")).rejects.toBeInstanceOf(
      BadRequestError,
    );
    await expect(openWorkspaceFile("/etc/passwd.md")).rejects.toBeInstanceOf(
      BadRequestError,
    );
    await expect(
      openWorkspaceFile("notes/../../escape.md"),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("rejects non-markdown files", async () => {
    writeFileSync(join(notesDir, "data.txt"), "plain text");

    await expect(openWorkspaceFile("notes/data.txt")).rejects.toBeInstanceOf(
      UnprocessableEntityError,
    );
  });

  test("requires path and conversationId", () => {
    const route = getRoute("documentForWorkspaceFile");
    expect(() => route.handler({ body: {} })).toThrow(BadRequestError);
    expect(() => route.handler({ body: { path: "notes/plan.md" } })).toThrow(
      BadRequestError,
    );
  });

  test("404s for a file that was never there", async () => {
    await expect(openWorkspaceFile("notes/missing.md")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  test("404s distinctly for a bound document whose file was deleted", async () => {
    const filePath = join(notesDir, "plan.md");
    writeFileSync(filePath, "will be deleted");
    const created = await openWorkspaceFile("notes/plan.md");
    rmSync(filePath);

    await expect(openWorkspaceFile("notes/plan.md")).rejects.toThrow(
      /file backing this document no longer exists/,
    );

    // The document row survives; the file is never resurrected from it.
    expect(getDocumentById(created.surfaceId)?.content).toBe("will be deleted");
    expect(() => readFileSync(filePath, "utf-8")).toThrow();
  });
});

describe("write-through to the backing file", () => {
  test("the client's document save rewrites the file", async () => {
    const filePath = join(notesDir, "plan.md");
    writeFileSync(filePath, "original body");
    const doc = await openWorkspaceFile("notes/plan.md");

    await saveViaRoute(doc.surfaceId, "plan.md", "saved from the editor");

    expect(readFileSync(filePath, "utf-8")).toBe("saved from the editor");
    expect(getDocumentById(doc.surfaceId)?.content).toBe(
      "saved from the editor",
    );
  });

  test("a document_update tool edit rewrites the file", async () => {
    const filePath = join(notesDir, "plan.md");
    writeFileSync(filePath, "original body");
    const doc = await openWorkspaceFile("notes/plan.md");

    const result = executeDocumentUpdate(
      {
        surface_id: doc.surfaceId,
        content: "appended by the assistant",
        mode: "append",
      },
      { ...makeToolContext(), sendToClient: () => {} },
    );
    expect(result.isError).toBe(false);

    const expected = "original body\n\nappended by the assistant";
    expect(readFileSync(filePath, "utf-8")).toBe(expected);
    expect(getDocumentById(doc.surfaceId)?.content).toBe(expected);
  });

  test("a document_replace_text tool edit rewrites the file", async () => {
    const filePath = join(notesDir, "plan.md");
    writeFileSync(filePath, "hello world");
    const doc = await openWorkspaceFile("notes/plan.md");

    const result = executeDocumentReplaceText(
      { surface_id: doc.surfaceId, find: "world", replace: "there" },
      { ...makeToolContext(), sendToClient: () => {} },
    );
    expect(result.isError).toBe(false);

    expect(readFileSync(filePath, "utf-8")).toBe("hello there");
    expect(getDocumentById(doc.surfaceId)?.content).toBe("hello there");
  });

  test("a failed file write fails the update instead of diverging", async () => {
    const filePath = join(notesDir, "plan.md");
    writeFileSync(filePath, "original body");
    const doc = await openWorkspaceFile("notes/plan.md");

    // Replace the file with a directory: the write primitive refuses it, so
    // the row must stay on the content that still matches what is on disk.
    rmSync(filePath);
    mkdirSync(filePath);

    const result = executeDocumentUpdate(
      { surface_id: doc.surfaceId, content: "never lands", mode: "replace" },
      { ...makeToolContext(), sendToClient: () => {} },
    );

    expect(result.isError).toBe(true);
    expect(getDocumentById(doc.surfaceId)?.content).toBe("original body");
  });

  test("documents with no backing file are untouched by the write-through", async () => {
    const route = getRoute("saveDocument");
    await route.handler({
      body: {
        surfaceId: "doc-plain",
        conversationId: CONVERSATION_ID,
        title: "Plain",
        content: "db only",
        wordCount: 2,
      },
    });

    const stored = getDocumentById("doc-plain");
    expect(stored?.content).toBe("db only");
    expect(stored?.workspacePath).toBeNull();
  });
});
