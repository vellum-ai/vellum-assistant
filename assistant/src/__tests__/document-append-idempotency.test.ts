import { beforeEach, describe, expect, test } from "bun:test";

import { getDocumentById } from "../documents/document-store.js";
import { getSqlite } from "../persistence/db-connection.js";
import {
  executeDocumentCreate,
  executeDocumentUpdate,
} from "../tools/document/document-tool.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";
import { resetDbForTesting } from "./db-test-helpers.js";

const CONVERSATION_ID = "conv-current";

/** Long enough to clear the store's minimum-duplicate-length floor. */
const OPENING =
  "Remote work reshaped the office long before anyone had a name for it.";

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/tmp/project",
    conversationId: CONVERSATION_ID,
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
      updated_at INTEGER NOT NULL,
      workspace_path TEXT
    );

    CREATE TABLE document_conversations (
      surface_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (surface_id, conversation_id),
      FOREIGN KEY (surface_id) REFERENCES documents(surface_id) ON DELETE CASCADE
    );
  `);
  raw
    .query(`INSERT OR IGNORE INTO conversations (id, created_at) VALUES (?, ?)`)
    .run(CONVERSATION_ID, Date.now());
}

function seedDocument(surfaceId: string, content: string): void {
  const now = Date.now();
  const raw = getSqlite();
  raw
    .query(
      `INSERT INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      surfaceId,
      CONVERSATION_ID,
      "Draft",
      content,
      content.split(/\s+/).filter(Boolean).length,
      now,
      now,
    );
  raw
    .query(
      `INSERT OR IGNORE INTO document_conversations (surface_id, conversation_id, created_at) VALUES (?, ?, ?)`,
    )
    .run(surfaceId, CONVERSATION_ID, now);
}

describe("document append idempotency", () => {
  beforeEach(() => {
    bootstrapDocumentTables();
  });

  test("an opening passed to both document_create and the first append lands once", () => {
    const created = executeDocumentCreate(
      { title: "Draft", initial_content: `# Draft\n\n${OPENING}` },
      makeContext(),
    );
    const surfaceId = parseResult<{ surface_id: string }>(created).surface_id;

    const result = executeDocumentUpdate(
      {
        surface_id: surfaceId,
        content: `# Draft\n\n${OPENING}\n\nThe second paragraph carries the argument forward.`,
        mode: "append",
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(getDocumentById(surfaceId)?.content).toBe(
      `# Draft\n\n${OPENING}\n\nThe second paragraph carries the argument forward.`,
    );
  });

  test("an append that only restates the tail writes nothing", () => {
    seedDocument("doc-restate", `# Draft\n\n${OPENING}`);

    const result = executeDocumentUpdate(
      { surface_id: "doc-restate", content: OPENING, mode: "append" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const body = parseResult<{ success: boolean; message: string }>(result);
    expect(body.success).toBe(true);
    expect(body.message).toBe(
      "Nothing appended: the content is already at the end of the document",
    );
    expect(getDocumentById("doc-restate")?.content).toBe(
      `# Draft\n\n${OPENING}`,
    );
  });

  test("the client is told what landed, not what was submitted", () => {
    seedDocument("doc-client", OPENING);
    const sent: { markdown: unknown; mode: unknown }[] = [];

    executeDocumentUpdate(
      {
        surface_id: "doc-client",
        content: `${OPENING}\n\nAnd then the rest.`,
        mode: "append",
      },
      makeContext({
        sendToClient: (message) => {
          if (message.type === "document_editor_update") {
            sent.push({ markdown: message.markdown, mode: message.mode });
          }
        },
      }),
    );

    expect(sent).toEqual([{ markdown: "And then the rest.", mode: "append" }]);
  });

  // ── Legitimate repetition the guard must not eat ──────────────────

  test("keeps a short repeated line, even back to back", () => {
    seedDocument("doc-refrain", "## Checklist\n\nTODO");

    executeDocumentUpdate(
      { surface_id: "doc-refrain", content: "TODO\n\nTODO", mode: "append" },
      makeContext(),
    );

    expect(getDocumentById("doc-refrain")?.content).toBe(
      "## Checklist\n\nTODO\n\nTODO\n\nTODO",
    );
  });

  test("keeps a repeated heading followed by new prose", () => {
    seedDocument("doc-heading", "# Weekly Notes\n\n## Monday");

    executeDocumentUpdate(
      {
        surface_id: "doc-heading",
        content: "## Monday\n\nShipped the importer.",
        mode: "append",
      },
      makeContext(),
    );

    expect(getDocumentById("doc-heading")?.content).toBe(
      "# Weekly Notes\n\n## Monday\n\n## Monday\n\nShipped the importer.",
    );
  });

  test("keeps a long paragraph that repeats something other than the tail", () => {
    seedDocument("doc-midway", `${OPENING}\n\nA later paragraph ends the doc.`);

    executeDocumentUpdate(
      { surface_id: "doc-midway", content: OPENING, mode: "append" },
      makeContext(),
    );

    expect(getDocumentById("doc-midway")?.content).toBe(
      `${OPENING}\n\nA later paragraph ends the doc.\n\n${OPENING}`,
    );
  });

  test("keeps content whose repetition starts partway into the append", () => {
    seedDocument("doc-partway", `# Draft\n\n${OPENING}`);

    executeDocumentUpdate(
      {
        surface_id: "doc-partway",
        content: `A fresh lead-in.\n\n${OPENING}`,
        mode: "append",
      },
      makeContext(),
    );

    expect(getDocumentById("doc-partway")?.content).toBe(
      `# Draft\n\n${OPENING}\n\nA fresh lead-in.\n\n${OPENING}`,
    );
  });

  test("replace mode is never deduplicated", () => {
    seedDocument("doc-replace", OPENING);

    executeDocumentUpdate(
      { surface_id: "doc-replace", content: OPENING, mode: "replace" },
      makeContext(),
    );

    expect(getDocumentById("doc-replace")?.content).toBe(OPENING);
  });
});
