import { beforeEach, describe, expect, test } from "bun:test";

import {
  getDocumentById,
  getDocumentsForConversation,
} from "../documents/document-store.js";
import { getSqlite } from "../persistence/db-connection.js";
import { executeDocumentCreate } from "../tools/document/document-tool.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";
import { resetDbForTesting } from "./db-test-helpers.js";

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/tmp/project",
    conversationId: "conv-current",
    trustClass: "trusted_contact",
    executionChannel: "slack",
    sendToClient: () => {},
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
  createdAt: number;
}): void {
  const raw = getSqlite();
  raw
    .query(`INSERT OR IGNORE INTO conversations (id, created_at) VALUES (?, ?)`)
    .run(params.conversationId, params.createdAt);
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
      params.createdAt,
      params.createdAt,
    );
  raw
    .query(
      `INSERT OR IGNORE INTO document_conversations (surface_id, conversation_id, created_at) VALUES (?, ?, ?)`,
    )
    .run(params.surfaceId, params.conversationId, params.createdAt);
}

describe("executeDocumentCreate — dedupe empty same-title document", () => {
  beforeEach(() => {
    bootstrapDocumentTables();
  });

  test("reuses an empty same-title doc when incoming content is non-empty", () => {
    const seededId = "doc-empty-seeded";
    seedDocument({
      surfaceId: seededId,
      conversationId: "conv-current",
      title: "My Post",
      content: "",
      createdAt: Date.now(),
    });

    const result = executeDocumentCreate(
      { title: "My Post", initial_content: "Hello" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    const body = parseResult<{
      surface_id: string;
      reused?: boolean;
      message?: string;
    }>(result);
    expect(body.surface_id).toBe(seededId);
    expect(body.reused).toBe(true);
    expect(body.message).toBe("Document editor reopened (deduped empty draft)");

    expect(getDocumentById(seededId)?.content).toBe("Hello");
    expect(getDocumentsForConversation("conv-current").length).toBe(1);
  });

  test("creates a new doc when incoming initial_content is empty (no dedupe)", () => {
    const seededId = "doc-empty-seeded";
    seedDocument({
      surfaceId: seededId,
      conversationId: "conv-current",
      title: "My Post",
      content: "",
      createdAt: Date.now(),
    });

    const result = executeDocumentCreate(
      { title: "My Post", initial_content: "" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    const body = parseResult<{ surface_id: string; reused?: boolean }>(result);
    expect(body.reused).toBeUndefined();
    expect(body.surface_id).not.toBe(seededId);
    expect(getDocumentsForConversation("conv-current").length).toBe(2);
  });

  test("does not dedupe when the seeded doc already has content", () => {
    const seededId = "doc-has-content";
    seedDocument({
      surfaceId: seededId,
      conversationId: "conv-current",
      title: "My Post",
      content: "already drafted",
      createdAt: Date.now(),
    });

    const result = executeDocumentCreate(
      { title: "My Post", initial_content: "Hello" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    const body = parseResult<{ surface_id: string; reused?: boolean }>(result);
    expect(body.reused).toBeUndefined();
    expect(body.surface_id).not.toBe(seededId);
    expect(getDocumentById(seededId)?.content).toBe("already drafted");
    expect(getDocumentsForConversation("conv-current").length).toBe(2);
  });

  test("does not dedupe when the seeded empty doc is outside the 5-minute window", () => {
    const seededId = "doc-stale-empty";
    seedDocument({
      surfaceId: seededId,
      conversationId: "conv-current",
      title: "My Post",
      content: "",
      // 10 minutes ago — outside the 5-minute dedupe window.
      createdAt: Date.now() - 10 * 60 * 1000,
    });

    const result = executeDocumentCreate(
      { title: "My Post", initial_content: "Hello" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    const body = parseResult<{ surface_id: string; reused?: boolean }>(result);
    expect(body.reused).toBeUndefined();
    expect(body.surface_id).not.toBe(seededId);
    expect(getDocumentById(seededId)?.content).toBe("");
    expect(getDocumentsForConversation("conv-current").length).toBe(2);
  });
});
