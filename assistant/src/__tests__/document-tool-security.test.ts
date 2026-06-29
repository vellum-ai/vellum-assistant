import { beforeEach, describe, expect, test } from "bun:test";

import { getDocumentById } from "../documents/document-store.js";
import { getSqlite } from "../persistence/db-connection.js";
import {
  executeDocumentDelete,
  executeDocumentList,
  executeDocumentRead,
  executeDocumentUpdate,
} from "../tools/document/document-tool.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";
import { resetDbForTesting } from "./db-test-helpers.js";

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/tmp/project",
    conversationId: "conv-current",
    trustClass: "trusted_contact",
    executionChannel: "slack",
    ...overrides,
  };
}

function parseResult<T>(result: ToolExecutionResult): T {
  return JSON.parse(result.content) as T;
}

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
}

function seedDocument(params: {
  surfaceId: string;
  conversationId: string;
  title: string;
  content: string;
  updatedAt: number;
}): void {
  const raw = getSqlite();
  raw
    .query(`INSERT OR IGNORE INTO conversations (id, created_at) VALUES (?, ?)`)
    .run(params.conversationId, params.updatedAt);
  raw
    .query(
      `INSERT INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.surfaceId,
      params.conversationId,
      params.title,
      params.content,
      params.content.split(/\s+/).filter(Boolean).length,
      params.updatedAt,
      params.updatedAt,
    );
  raw
    .query(
      `INSERT OR IGNORE INTO document_conversations (surface_id, conversation_id, created_at) VALUES (?, ?, ?)`,
    )
    .run(params.surfaceId, params.conversationId, params.updatedAt);
}

function seedFixtureDocuments(): void {
  seedDocument({
    surfaceId: "doc-current",
    conversationId: "conv-current",
    title: "Current Business Plan",
    content: "current plan",
    updatedAt: 1000,
  });
  seedDocument({
    surfaceId: "doc-other",
    conversationId: "conv-other",
    title: "Other Business Plan",
    content: "other plan",
    updatedAt: 2000,
  });
  seedDocument({
    surfaceId: "doc-percent",
    conversationId: "conv-other",
    title: "100% Plan",
    content: "literal percent",
    updatedAt: 3000,
  });
}

describe("document tool security", () => {
  beforeEach(() => {
    bootstrapDocumentTables();
    seedFixtureDocuments();
  });

  test("scopes title search to the current conversation for non-guardian remote actors", () => {
    const result = executeDocumentList(
      { query: "Business Plan" },
      makeContext({ trustClass: "trusted_contact", executionChannel: "slack" }),
    );

    const body = parseResult<{ documents: Array<{ surface_id: string }> }>(
      result,
    );
    expect(body.documents.map((doc) => doc.surface_id)).toEqual([
      "doc-current",
    ]);
  });

  test("does not treat SQL LIKE wildcards as title-search wildcards", () => {
    const result = executeDocumentList(
      { query: "%" },
      makeContext({ trustClass: "guardian", executionChannel: "telegram" }),
    );

    const body = parseResult<{ documents: Array<{ surface_id: string }> }>(
      result,
    );
    expect(body.documents.map((doc) => doc.surface_id)).toEqual([
      "doc-percent",
    ]);
  });

  test("allows guardian and local actors to use documents from previous conversations", () => {
    const guardianContext = makeContext({
      trustClass: "guardian",
      executionChannel: "telegram",
      sendToClient: () => {},
    });
    const guardianList = executeDocumentList(
      { query: "Other Business" },
      guardianContext,
    );
    const guardianBody = parseResult<{
      documents: Array<{ surface_id: string }>;
    }>(guardianList);
    expect(guardianBody.documents.map((doc) => doc.surface_id)).toEqual([
      "doc-other",
    ]);

    const localRead = executeDocumentRead(
      { surface_id: "doc-other" },
      makeContext({ trustClass: "unknown", executionChannel: "vellum" }),
    );
    const localBody = parseResult<{
      success: boolean;
      surface_id: string;
      content: string;
    }>(localRead);
    expect(localBody).toMatchObject({
      success: true,
      surface_id: "doc-other",
      content: "other plan",
    });

    const guardianUpdate = executeDocumentUpdate(
      { surface_id: "doc-other", content: "guardian edit", mode: "replace" },
      guardianContext,
    );
    expect(guardianUpdate.isError).toBe(false);
    expect(getDocumentById("doc-other")?.content).toBe("guardian edit");

    const guardianDelete = executeDocumentDelete(
      { surface_id: "doc-other" },
      guardianContext,
    );
    expect(guardianDelete.isError).toBe(false);
    expect(getDocumentById("doc-other")).toBeNull();
  });

  test("blocks cross-conversation read, update, and delete for non-guardian remote actors", () => {
    const remoteContext = makeContext({
      trustClass: "trusted_contact",
      executionChannel: "slack",
      sendToClient: () => {},
    });

    const read = executeDocumentRead(
      { surface_id: "doc-other" },
      remoteContext,
    );
    expect(read.isError).toBe(true);
    expect(parseResult<{ error: string }>(read).error).toBe(
      "Document not found",
    );

    const update = executeDocumentUpdate(
      {
        surface_id: "doc-other",
        content: "updated by another conversation",
        mode: "replace",
      },
      remoteContext,
    );
    expect(update.isError).toBe(true);
    expect(getDocumentById("doc-other")?.content).toBe("other plan");

    const deleted = executeDocumentDelete(
      { surface_id: "doc-other" },
      remoteContext,
    );
    expect(deleted.isError).toBe(true);
    expect(getDocumentById("doc-other")).not.toBeNull();
  });

  test("keeps current-conversation documents editable and deletable", () => {
    const remoteContext = makeContext({
      trustClass: "trusted_contact",
      executionChannel: "slack",
      sendToClient: () => {},
    });

    const read = executeDocumentRead(
      { surface_id: "doc-current" },
      remoteContext,
    );
    expect(read.isError).toBe(false);

    const update = executeDocumentUpdate(
      { surface_id: "doc-current", content: "revised plan", mode: "replace" },
      remoteContext,
    );
    expect(update.isError).toBe(false);
    expect(getDocumentById("doc-current")?.content).toBe("revised plan");

    const deleted = executeDocumentDelete(
      { surface_id: "doc-current" },
      remoteContext,
    );
    expect(deleted.isError).toBe(false);
    expect(getDocumentById("doc-current")).toBeNull();
  });
});

describe("executeDocumentUpdate — input validation", () => {
  beforeEach(() => {
    bootstrapDocumentTables();
    seedFixtureDocuments();
  });

  test("resolves to the conversation's document when surface_id is omitted", () => {
    const result = executeDocumentUpdate(
      { content: "appended chunk" },
      makeContext({ sendToClient: () => {} }),
    );
    expect(result.isError).toBe(false);
    const body = parseResult<{ surface_id: string; success: boolean }>(result);
    expect(body.success).toBe(true);
    expect(body.surface_id).toBe("doc-current");
  });

  test("returns Invalid input when content is missing", () => {
    const result = executeDocumentUpdate(
      { surface_id: "doc-x" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    const body = parseResult<{ error: string }>(result);
    expect(body.error).toBe(
      "Invalid input: content is required and must be a string",
    );
  });

  test("allows empty string content (falls through to access check)", () => {
    const result = executeDocumentUpdate(
      { surface_id: "doc-x", content: "" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    const body = parseResult<{ error: string }>(result);
    // Did NOT fail input validation; fell through to access/not-found path.
    expect(body.error).toBe("Document not found");
  });

  test("returns Invalid input when mode is not replace or append", () => {
    const result = executeDocumentUpdate(
      { surface_id: "doc-x", content: "hi", mode: "bogus" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    const body = parseResult<{ error: string }>(result);
    expect(body.error).toBe(
      'Invalid input: mode must be "replace" or "append"',
    );
  });

  test("treats mode: null the same as undefined (factory validator accepts both)", () => {
    // validateInputAgainstSchema treats null as "absent" for enum checks, so
    // the executor must agree — { mode: null } should fall through to the
    // access check, not return a confusing 'mode must be ...' error.
    const result = executeDocumentUpdate(
      { surface_id: "doc-x", content: "hi", mode: null },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    const body = parseResult<{ error: string }>(result);
    expect(body.error).not.toContain("Invalid input: mode");
    expect(body.error).toBe("Document not found");
  });

  test("executeDocumentRead returns Invalid input when surface_id is missing", () => {
    const result = executeDocumentRead({}, makeContext());
    expect(result.isError).toBe(true);
    const body = parseResult<{ error: string }>(result);
    expect(body.error).toContain("Invalid input: surface_id is required");
  });

  test("executeDocumentDelete returns Invalid input when surface_id is missing", () => {
    const result = executeDocumentDelete({}, makeContext());
    expect(result.isError).toBe(true);
    const body = parseResult<{ error: string }>(result);
    expect(body.error).toContain("Invalid input: surface_id is required");
  });
});
