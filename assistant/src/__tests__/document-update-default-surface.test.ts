import { beforeEach, describe, expect, test } from "bun:test";

import { getDocumentById } from "../documents/document-store.js";
import { getSqlite } from "../persistence/db-connection.js";
import { executeDocumentUpdate } from "../tools/document/document-tool.js";
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
  updatedAt?: number;
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
      params.updatedAt ?? params.createdAt,
    );
  raw
    .query(
      `INSERT OR IGNORE INTO document_conversations (surface_id, conversation_id, created_at) VALUES (?, ?, ?)`,
    )
    .run(params.surfaceId, params.conversationId, params.createdAt);
}

describe("executeDocumentUpdate — default surface_id resolution", () => {
  beforeEach(() => {
    bootstrapDocumentTables();
  });

  test("appends to the conversation's only document when surface_id is omitted", () => {
    const surfaceId = "doc-only";
    seedDocument({
      surfaceId,
      conversationId: "conv-current",
      title: "Dating in 2026",
      content: "# Dating in 2026\n\nIntro.",
      createdAt: Date.now(),
    });

    const result = executeDocumentUpdate(
      { content: "## Section two", mode: "append" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const body = parseResult<{ surface_id: string; success: boolean }>(result);
    expect(body.success).toBe(true);
    expect(body.surface_id).toBe(surfaceId);
    expect(getDocumentById(surfaceId)?.content).toBe(
      "# Dating in 2026\n\nIntro.\n\n## Section two",
    );
  });

  test("targets the most recently updated document when several exist", () => {
    const now = Date.now();
    seedDocument({
      surfaceId: "doc-old",
      conversationId: "conv-current",
      title: "Old",
      content: "old",
      createdAt: now - 10_000,
      updatedAt: now - 10_000,
    });
    seedDocument({
      surfaceId: "doc-fresh",
      conversationId: "conv-current",
      title: "Fresh",
      content: "fresh",
      createdAt: now,
      updatedAt: now,
    });

    const result = executeDocumentUpdate({ content: "more" }, makeContext());

    expect(result.isError).toBe(false);
    const body = parseResult<{ surface_id: string }>(result);
    expect(body.surface_id).toBe("doc-fresh");
    expect(getDocumentById("doc-fresh")?.content).toBe("fresh\n\nmore");
    expect(getDocumentById("doc-old")?.content).toBe("old");
  });

  test("an explicit surface_id still wins over the default", () => {
    const now = Date.now();
    seedDocument({
      surfaceId: "doc-target",
      conversationId: "conv-current",
      title: "Target",
      content: "target",
      createdAt: now - 10_000,
      updatedAt: now - 10_000,
    });
    seedDocument({
      surfaceId: "doc-fresh",
      conversationId: "conv-current",
      title: "Fresh",
      content: "fresh",
      createdAt: now,
      updatedAt: now,
    });

    const result = executeDocumentUpdate(
      { surface_id: "doc-target", content: "hit" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(parseResult<{ surface_id: string }>(result).surface_id).toBe(
      "doc-target",
    );
    expect(getDocumentById("doc-target")?.content).toBe("target\n\nhit");
    expect(getDocumentById("doc-fresh")?.content).toBe("fresh");
  });

  test("errors helpfully when the conversation has no document", () => {
    const result = executeDocumentUpdate(
      { content: "orphan chunk" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("no document is open");
    expect(result.content).toContain("document_create");
  });

  test("still requires content", () => {
    seedDocument({
      surfaceId: "doc-only",
      conversationId: "conv-current",
      title: "X",
      content: "x",
      createdAt: Date.now(),
    });

    const result = executeDocumentUpdate({ mode: "append" }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("content is required");
  });
});
