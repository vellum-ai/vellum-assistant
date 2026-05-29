/**
 * Recover conversations from the on-disk view directories under
 * `workspace/conversations/<id>/`.
 *
 * Each conversation directory holds:
 *   - `meta.json`        — `{ id, title?, type?, channel?, createdAt?, updatedAt? }`
 *   - `messages.jsonl`   — one JSON record per line, `{ role, ts?, content?,
 *                          toolCalls?, toolResults?, attachments? }`
 *
 * Replaying these into SQLite reconstructs the conversation table after a
 * database wipe. The function is idempotent: conversations whose id already
 * exists in the DB are skipped without modification.
 *
 * Used by:
 *   - workspace migration 028 (one-shot at startup against `getDb()`)
 *   - `assistant db repair` conversation-backfill step (any time, against
 *     a connection the command opens itself)
 *
 * The caller supplies the drizzle instance so this function makes no
 * assumptions about which database connection or workspace it's operating
 * on — useful for tests, CLI tools that open their own handle, and the
 * normal startup migration path.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import type { DrizzleDb } from "../../memory/db-connection.js";
import { conversations, messages } from "../../memory/schema/conversations.js";

// ---------------------------------------------------------------------------
// On-disk record shapes
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface RecoveryResult {
  /** Conversations newly inserted into the DB. */
  recovered: number;
  /** Conversations skipped (already present, or unreadable on disk). */
  skipped: number;
  /** Conversations that matched everything but failed to insert. */
  errors: number;
  /**
   * Human-readable warning lines, one per skip or error reason. Bounded
   * by `warningCap` if provided (default unbounded). Callers that surface
   * these to a user can cap further on the human-render side.
   */
  warnings: string[];
}

export interface RecoveryOptions {
  /** Cap the number of warning lines retained. Default: unbounded. */
  warningCap?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Walk every directory under `<workspaceDir>/conversations/` and replay the
 * meta + messages into `db`. Returns counters and per-entry warnings.
 *
 * If the conversations directory does not exist, returns zeros with no
 * warnings (it's a valid empty state — the workspace just hasn't recorded
 * any conversations yet).
 *
 * Safe to call concurrently with a running daemon; the per-conversation
 * existence check is the idempotency guard.
 */
export function recoverConversationsFromDisk(
  workspaceDir: string,
  db: DrizzleDb,
  opts: RecoveryOptions = {},
): RecoveryResult {
  const result: RecoveryResult = {
    recovered: 0,
    skipped: 0,
    errors: 0,
    warnings: [],
  };
  const warningCap = opts.warningCap ?? Number.POSITIVE_INFINITY;

  const pushWarning = (line: string): void => {
    if (result.warnings.length < warningCap) result.warnings.push(line);
  };

  const conversationsDir = join(workspaceDir, "conversations");
  if (!existsSync(conversationsDir)) return result;

  let entries: string[];
  try {
    entries = readdirSync(conversationsDir);
  } catch (err) {
    pushWarning(`failed to read conversations directory: ${String(err)}`);
    return result;
  }

  for (const entry of entries) {
    const dirPath = join(conversationsDir, entry);

    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const metaPath = join(dirPath, "meta.json");
    if (!existsSync(metaPath)) {
      pushWarning(`${entry}: missing meta.json`);
      result.skipped++;
      continue;
    }

    let meta: DiskMeta;
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf-8")) as DiskMeta;
    } catch (err) {
      pushWarning(`${entry}: malformed meta.json: ${String(err)}`);
      result.skipped++;
      continue;
    }

    if (!meta.id) {
      pushWarning(`${entry}: meta.json missing id`);
      result.skipped++;
      continue;
    }

    const existing = db
      .select()
      .from(conversations)
      .where(eq(conversations.id, meta.id))
      .get();

    if (existing) {
      result.skipped++;
      continue;
    }

    const messageRecords: DiskMessageRecord[] = [];
    const messagesPath = join(dirPath, "messages.jsonl");
    if (existsSync(messagesPath)) {
      try {
        const raw = readFileSync(messagesPath, "utf-8");
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            messageRecords.push(JSON.parse(trimmed) as DiskMessageRecord);
          } catch {
            pushWarning(`${entry}: malformed JSONL line in messages.jsonl`);
          }
        }
      } catch (err) {
        pushWarning(`${entry}: failed to read messages.jsonl: ${String(err)}`);
      }
    }

    const createdAt = parseEpochMs(meta.createdAt) ?? Date.now();
    const updatedAt = parseEpochMs(meta.updatedAt) ?? createdAt;

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
      result.recovered++;
    } catch (err) {
      pushWarning(`${meta.id} (${entry}): insert failed: ${String(err)}`);
      result.errors++;
    }
  }

  return result;
}
