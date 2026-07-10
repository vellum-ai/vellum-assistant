/**
 * Repair step: conversation backfill from the on-disk view.
 *
 * Each conversation directory under `<workspace>/conversations/<id>/` holds
 * a `meta.json` and `messages.jsonl` written by the runtime as the source
 * of truth for the disk view. If the SQLite database was wiped, restored
 * from an old backup, or otherwise lost the `conversations`/`messages`
 * rows, this step replays the on-disk files to reconstruct them.
 *
 * Workspace migration 028 performs the same kind of recovery at startup,
 * but its body is a frozen snapshot that runs against historical
 * workspaces. This step owns its own copy so the live `db repair` surface
 * can evolve independently — bug fixes, new edge cases, or schema changes
 * don't risk altering migration 028's behavior on workspaces that have
 * already run it.
 *
 * This step opens its own read-write bun:sqlite handle so the command
 * works when the daemon is down — the whole point of the local transport.
 *
 * Idempotent: existing conversation rows are skipped without modification.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";

import {
  conversations,
  messages,
} from "../../../persistence/schema/conversations.js";
import * as schema from "../../../persistence/schema/index.js";
import { getWorkspaceDir } from "../../../util/platform.js";
import type { RepairContext, RepairStep, StepResult } from "./repair-steps.js";

/**
 * Cap on warning lines surfaced in the human-mode output. The JSON payload
 * carries the full list (subject to `WARNING_CAP_TOTAL`) so scripted callers
 * never lose detail.
 */
const MAX_REPORTED_WARNING_LINES = 20;

/**
 * Hard cap on warnings retained in memory, even for the JSON payload.
 * Prevents a workspace with thousands of malformed entries from blowing
 * memory on the report object.
 */
const WARNING_CAP_TOTAL = 500;

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
// Step body
// ---------------------------------------------------------------------------

async function runConversationBackfill(
  ctx: RepairContext,
): Promise<StepResult> {
  // Open RW so we can insert recovered rows. Mirror the daemon's pragmas
  // for consistent journal/FK behavior.
  let sqlite: Database;
  try {
    sqlite = new Database(ctx.dbPath);
    sqlite.exec("PRAGMA journal_mode=WAL");
    sqlite.exec("PRAGMA synchronous=FULL");
    sqlite.exec("PRAGMA busy_timeout=5000");
    sqlite.exec("PRAGMA foreign_keys = ON");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      summary: "could not open database for conversation backfill",
      detailLines: [msg],
      data: {
        recovered: 0,
        skipped: 0,
        errors: 1,
        warnings: [msg],
        openFailed: true,
      },
    };
  }

  try {
    const db = drizzle(sqlite, { schema });
    const workspaceDir = getWorkspaceDir();

    let recovered = 0;
    let skipped = 0;
    let errors = 0;
    const warnings: string[] = [];
    const pushWarning = (line: string): void => {
      if (warnings.length < WARNING_CAP_TOTAL) warnings.push(line);
    };

    const conversationsDir = join(workspaceDir, "conversations");
    if (existsSync(conversationsDir)) {
      let entries: string[];
      try {
        entries = readdirSync(conversationsDir);
      } catch (err) {
        pushWarning(`failed to read conversations directory: ${String(err)}`);
        entries = [];
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
          skipped++;
          continue;
        }

        let meta: DiskMeta;
        try {
          meta = JSON.parse(readFileSync(metaPath, "utf-8")) as DiskMeta;
        } catch (err) {
          pushWarning(`${entry}: malformed meta.json: ${String(err)}`);
          skipped++;
          continue;
        }

        if (!meta.id) {
          pushWarning(`${entry}: meta.json missing id`);
          skipped++;
          continue;
        }

        const existing = db
          .select()
          .from(conversations)
          .where(eq(conversations.id, meta.id))
          .get();

        if (existing) {
          skipped++;
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
            pushWarning(
              `${entry}: failed to read messages.jsonl: ${String(err)}`,
            );
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
          pushWarning(`${meta.id} (${entry}): insert failed: ${String(err)}`);
          errors++;
        }
      }
    }

    const summary =
      recovered === 0 && errors === 0
        ? `nothing to backfill (${skipped} on-disk conversation${skipped === 1 ? "" : "s"} already present)`
        : `recovered ${recovered}, skipped ${skipped}, ${errors} error${errors === 1 ? "" : "s"}`;

    const truncatedWarnings = warnings.slice(0, MAX_REPORTED_WARNING_LINES);
    const detailLines =
      warnings.length > MAX_REPORTED_WARNING_LINES
        ? [
            ...truncatedWarnings,
            `+ ${warnings.length - MAX_REPORTED_WARNING_LINES} more (use --json for full list)`,
          ]
        : truncatedWarnings;

    // Errors during insert are surfaced as a non-halting failure so later
    // steps still run. Warnings without errors (malformed JSONL lines,
    // missing meta.json) are not themselves a failure — they're skips.
    if (errors > 0) {
      return {
        status: "error",
        summary,
        detailLines,
        data: { recovered, skipped, errors, warnings },
      };
    }

    return {
      status: "ok",
      summary,
      detailLines,
      data: { recovered, skipped, errors, warnings },
    };
  } finally {
    sqlite.close();
  }
}

export const conversationBackfillStep: RepairStep = {
  name: "conversation-backfill",
  description:
    "Replay workspace/conversations/<id>/{meta.json,messages.jsonl} into SQLite",
  run: runConversationBackfill,
};
