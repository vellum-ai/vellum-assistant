/**
 * Workspace migration 028: Recover conversations from disk-view directories.
 *
 * If the SQLite database was recreated empty but the disk-view directories
 * under `workspace/conversations/` still exist, this migration reads each
 * conversation's `meta.json` and `messages.jsonl` and re-inserts the rows
 * into the database.
 *
 * Idempotent: conversations already present in the DB are skipped.
 * Malformed files are skipped with warnings — they do not crash the migration.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { getDb } from "../../memory/db.js";
import { conversations, messages } from "../../memory/schema/conversations.js";
import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migrations");

interface DiskMeta {
  id: string;
  title?: string;
  type?: string;
  channel?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface DiskToolCall {
  name?: string;
  input?: unknown;
}

interface DiskToolResult {
  content?: unknown;
}

interface DiskMessageRecord {
  role: string;
  ts?: string;
  content?: string;
  toolCalls?: DiskToolCall[];
  toolResults?: DiskToolResult[];
  attachments?: unknown[];
}

function parseEpochMs(isoString: string | undefined): number | null {
  if (!isoString) return null;
  const ms = new Date(isoString).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function buildContentBlocks(record: DiskMessageRecord): unknown[] {
  const blocks: unknown[] = [];

  if (record.content) {
    blocks.push({ type: "text", text: record.content });
  }

  if (Array.isArray(record.toolCalls)) {
    for (const tc of record.toolCalls) {
      blocks.push({
        type: "tool_use",
        id: randomUUID(),
        name: tc.name ?? "unknown",
        input: tc.input ?? {},
      });
    }
  }

  if (Array.isArray(record.toolResults)) {
    for (const tr of record.toolResults) {
      blocks.push({
        type: "tool_result",
        tool_use_id: "",
        content:
          typeof tr.content === "string"
            ? tr.content
            : JSON.stringify(tr.content),
      });
    }
  }

  // content column is NOT NULL — ensure at least one block
  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "" });
  }

  return blocks;
}

export const recoverConversationsFromDiskViewMigration: WorkspaceMigration = {
  id: "028-recover-conversations-from-disk-view",
  description:
    "Recover conversations from disk-view directories into the database",

  run(workspaceDir: string): void {
    const conversationsDir = join(workspaceDir, "conversations");
    if (!existsSync(conversationsDir)) return;

    const db = getDb();

    let entries: string[];
    try {
      entries = readdirSync(conversationsDir);
    } catch (err) {
      log.warn(`Failed to read conversations directory: ${err}`);
      return;
    }

    let recovered = 0;
    let skipped = 0;
    let errors = 0;

    for (const entry of entries) {
      const dirPath = join(conversationsDir, entry);

      // Skip non-directories
      try {
        if (!statSync(dirPath).isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }

      // Read and parse meta.json
      const metaPath = join(dirPath, "meta.json");
      if (!existsSync(metaPath)) {
        log.warn(`Skipping ${entry}: missing meta.json`);
        skipped++;
        continue;
      }

      let meta: DiskMeta;
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf-8")) as DiskMeta;
      } catch (err) {
        log.warn(`Skipping ${entry}: malformed meta.json: ${err}`);
        skipped++;
        continue;
      }

      if (!meta.id) {
        log.warn(`Skipping ${entry}: meta.json missing id`);
        skipped++;
        continue;
      }

      // Check if conversation already exists in DB (idempotency)
      const existing = db
        .select()
        .from(conversations)
        .where(eq(conversations.id, meta.id))
        .get();

      if (existing) {
        skipped++;
        continue;
      }

      // Parse messages.jsonl
      const messagesPath = join(dirPath, "messages.jsonl");
      const messageRecords: DiskMessageRecord[] = [];

      if (existsSync(messagesPath)) {
        try {
          const raw = readFileSync(messagesPath, "utf-8");
          for (const line of raw.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              messageRecords.push(JSON.parse(trimmed) as DiskMessageRecord);
            } catch {
              log.warn(
                `Skipping malformed JSONL line in ${entry}/messages.jsonl`,
              );
            }
          }
        } catch (err) {
          log.warn(`Failed to read messages.jsonl for ${entry}: ${err}`);
        }
      }

      // Compute timestamps
      const createdAt = parseEpochMs(meta.createdAt) ?? Date.now();
      const updatedAt = parseEpochMs(meta.updatedAt) ?? createdAt;

      // Insert conversation + messages in a transaction
      try {
        db.transaction((tx) => {
          tx.insert(conversations)
            .values({
              id: meta.id,
              title: meta.title ?? null,
              createdAt,
              updatedAt,
              conversationType: meta.type ?? "standard",
              originChannel: meta.channel ?? null,
              source: "user",
              memoryScopeId: "default",
              isAutoTitle: 1,
              totalInputTokens: 0,
              totalOutputTokens: 0,
              totalEstimatedCost: 0,
              contextSummary: null,
              contextCompactedMessageCount: 0,
              contextCompactedAt: null,
              originInterface: null,
              forkParentConversationId: null,
              forkParentMessageId: null,
              scheduleJobId: null,
            })
            .run();

          for (const record of messageRecords) {
            const contentBlocks = buildContentBlocks(record);
            const msgCreatedAt = parseEpochMs(record.ts) ?? createdAt;

            tx.insert(messages)
              .values({
                id: randomUUID(),
                conversationId: meta.id,
                role: record.role,
                content: JSON.stringify(contentBlocks),
                createdAt: msgCreatedAt,
                metadata: null,
              })
              .run();
          }
        });

        recovered++;
      } catch (err) {
        log.warn(`Failed to insert conversation ${meta.id} (${entry}): ${err}`);
        errors++;
      }
    }

    if (recovered > 0 || errors > 0) {
      log.info(
        `Recover conversations from disk-view: recovered=${recovered}, skipped=${skipped}, errors=${errors}`,
      );
    }
  },

  // No-op: deleting recovered conversation data from the database would cause
  // data loss — the disk-view files are the only remaining copy after the
  // original DB was lost.
  down(_workspaceDir: string): void {},
};
