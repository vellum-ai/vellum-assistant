import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../memory/db-connection.js";
import { createMessagesFts } from "../memory/migrations/116-messages-fts.js";
import { migrateNormalizeSlackExternalContent } from "../memory/migrations/249-normalize-slack-external-content.js";
import * as schema from "../memory/schema.js";
import { writeSlackMetadata } from "../messaging/providers/slack/message-metadata.js";
import { wrapUntrustedContent } from "../security/untrusted-content.js";

interface MessageRow {
  id: string;
  content: string;
  metadata: string | null;
}

interface FtsRow {
  content: string;
}

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

function bootstrapConversationTables(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      metadata TEXT
    );

    INSERT INTO conversations (id, title, created_at, updated_at)
    VALUES ('conv-slack', 'Slack conversation', 1000, 1000);
  `);
}

function slackEnvelope(
  channelTs: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    userMessageChannel: "slack",
    assistantMessageChannel: "slack",
    slackMeta: writeSlackMetadata({
      source: "slack",
      channelId: "C0123",
      channelTs,
      eventKind: "message",
      displayName: "@alice",
    }),
    ...extra,
  });
}

function insertMessage(
  raw: Database,
  id: string,
  content: string,
  metadata: string,
): void {
  raw
    .query(
      /*sql*/ `
        INSERT INTO messages (id, conversation_id, role, content, created_at, metadata)
        VALUES (?, 'conv-slack', 'user', ?, 1000, ?)
      `,
    )
    .run(id, content, metadata);
}

function getRows(raw: Database): Record<string, MessageRow> {
  const rows = raw
    .query(`SELECT id, content, metadata FROM messages ORDER BY id`)
    .all() as MessageRow[];
  return Object.fromEntries(rows.map((row) => [row.id, row]));
}

function getFtsContent(raw: Database, messageId: string): string {
  const row = raw
    .query(`SELECT content FROM messages_fts WHERE message_id = ?`)
    .get(messageId) as FtsRow | null;
  return row?.content ?? "";
}

describe("migrateNormalizeSlackExternalContent", () => {
  test("normalizes complete Slack envelopes and leaves unrelated rows unchanged", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapConversationTables(raw);
    createMessagesFts(db);

    const wrappedPlain = wrapUntrustedContent("plain Slack text", {
      source: "slack",
      sourceDetail: "@alice",
    });
    const wrappedBlock = wrapUntrustedContent("block Slack text", {
      source: "slack",
      sourceDetail: "@alice",
    });
    const jsonContent = JSON.stringify([
      { type: "text", text: wrappedBlock },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
      },
      { type: "file", source: { type: "file_id", file_id: "file_1" } },
    ]);
    const nonSlackWrapped = wrapUntrustedContent("web text", {
      source: "web",
      sourceDetail: "https://example.com",
    });
    const guardianMetadata = slackEnvelope("1700000003.000000", {
      provenanceTrustClass: "guardian",
    });

    insertMessage(
      raw,
      "slack-plain",
      wrappedPlain,
      slackEnvelope("1700000000.000000"),
    );
    insertMessage(
      raw,
      "slack-json",
      jsonContent,
      slackEnvelope("1700000001.000000"),
    );
    insertMessage(
      raw,
      "non-slack",
      nonSlackWrapped,
      JSON.stringify({ userMessageChannel: "web" }),
    );
    insertMessage(raw, "guardian-raw", "guardian Slack text", guardianMetadata);

    migrateNormalizeSlackExternalContent(db);
    const afterFirstRun = getRows(raw);
    migrateNormalizeSlackExternalContent(db);
    const afterSecondRun = getRows(raw);

    expect(afterSecondRun).toEqual(afterFirstRun);

    expect(afterFirstRun["slack-plain"]?.content).toBe("plain Slack text");
    const plainMetadata = JSON.parse(
      afterFirstRun["slack-plain"]!.metadata!,
    ) as Record<string, unknown>;
    expect(plainMetadata.provenanceTrustClass).toBe("unknown");
    expect(typeof plainMetadata.slackMeta).toBe("string");

    const normalizedBlocks = JSON.parse(afterFirstRun["slack-json"]!.content);
    expect(normalizedBlocks).toEqual([
      { type: "text", text: "block Slack text" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
      },
      { type: "file", source: { type: "file_id", file_id: "file_1" } },
    ]);
    const jsonMetadata = JSON.parse(
      afterFirstRun["slack-json"]!.metadata!,
    ) as Record<string, unknown>;
    expect(jsonMetadata.provenanceTrustClass).toBe("unknown");

    expect(afterFirstRun["non-slack"]?.content).toBe(nonSlackWrapped);
    expect(afterFirstRun["non-slack"]?.metadata).toBe(
      JSON.stringify({ userMessageChannel: "web" }),
    );

    expect(afterFirstRun["guardian-raw"]?.content).toBe("guardian Slack text");
    expect(afterFirstRun["guardian-raw"]?.metadata).toBe(guardianMetadata);

    expect(getFtsContent(raw, "slack-plain")).toBe("plain Slack text");
    expect(getFtsContent(raw, "slack-json")).toContain("block Slack text");
    expect(getFtsContent(raw, "slack-json")).not.toContain("<external_content");
  });
});
