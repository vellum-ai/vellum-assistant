// ---------------------------------------------------------------------------
// Skill-update receipts: the durable store.
// ---------------------------------------------------------------------------
//
// A background pass can rewrite several managed skills within minutes. A
// receipt collapses one such burst into one announcement: every rewrite
// lands here as an entry, the entries accumulate on the one open receipt,
// and the tick job
// (`skill-update-receipt-job.ts`) seals the receipt once the burst has
// settled and announces it once.
//
// Two tables on the memory connection (`assistant-memory.db`), owned by this
// module and created by it, idempotently and fail-open, the way the memory
// plugin creates its own storage (see `v3/plugin-schema.ts`): never by the
// global migration chain that gates database readiness.
//
//   skill_update_receipts        one row per burst, with a lifecycle
//   skill_update_receipt_entries one row per rewrite, keyed by the tool call
//
// The lifecycle is `open` → `sealed` → one of `delivered`,
// `settled_no_row`, `undelivered`. A receipt never reopens.
//
// Three invariants the schema and the seal enforce, which the tick job and
// the producer rely on:
//
//   1. At most one receipt is open, held by the partial unique index on
//      `status`. Two writers that both find no open receipt cannot both
//      create one; the loser re-runs and joins the winner's.
//   2. An entry belongs to exactly one receipt and is stored once. The entry
//      id is the producing tool call's, so a re-executed call is a no-op.
//   3. Evaluation cannot split a burst. Every append bumps the receipt's
//      `rev` in the transaction that inserts the entry, and the seal is a
//      compare-and-set on `rev`: an append that commits before the seal moves
//      `rev` and the seal changes nothing (the tick re-evaluates with the
//      entry counted); an append that commits after finds no open receipt
//      and opens the next one. Membership is read after the seal succeeds,
//      so it is final.
//
// Appends run as immediate transactions: SQLite hands the write lock out at
// BEGIN, so a second writer, in this process or another, waits its turn
// rather than reading a snapshot the first writer is about to change.

import { v4 as uuid } from "uuid";

import { getLogger } from "./logging.js";
import {
  ensuredMemorySqlite,
  ensureOncePerConnection,
  type MemorySqlite,
} from "./memory-db.js";

const log = getLogger("skill-update-receipt-store");

const RECEIPTS_TABLE = "skill_update_receipts";
const ENTRIES_TABLE = "skill_update_receipt_entries";

/**
 * Create both tables and their indexes. Idempotent (`IF NOT EXISTS`).
 * Exported so tests can stand up the schema on an in-memory database.
 */
export function ensureSkillUpdateReceiptSchema(memoryRaw: MemorySqlite): void {
  memoryRaw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS ${RECEIPTS_TABLE} (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      rev INTEGER NOT NULL DEFAULT 0,
      first_entry_at INTEGER NOT NULL,
      last_entry_at INTEGER NOT NULL,
      sealed_at INTEGER,
      sealed_by TEXT,
      emit_attempts INTEGER NOT NULL DEFAULT 0,
      settled_at INTEGER,
      settled_reason TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_update_receipts_open
      ON ${RECEIPTS_TABLE}(status) WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS idx_skill_update_receipts_status
      ON ${RECEIPTS_TABLE}(status, sealed_at);
    CREATE TABLE IF NOT EXISTS ${ENTRIES_TABLE} (
      entry_id TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      name TEXT NOT NULL,
      change_summary TEXT NOT NULL,
      source_conversation_id TEXT,
      run_conversation_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_skill_update_receipt_entries_receipt
      ON ${ENTRIES_TABLE}(receipt_id, created_at);
  `);
}

const ensureSchemaOnce = ensureOncePerConnection(
  ensureSkillUpdateReceiptSchema,
  "failed to ensure the skill-update receipt tables; receipts degraded",
);

/** The memory connection with the receipt schema ensured, or null. */
function receiptSqlite(context: string): MemorySqlite | null {
  return ensuredMemorySqlite(context, ensureSchemaOnce);
}

/**
 * Ensure the receipt schema at boot, the way the memory plugin's `init` hook
 * ensures its other plugin-owned tables. Fail-open: an unopenable memory
 * database degrades every store call to a reported failure.
 */
export function ensureSkillUpdateReceiptSchemaAtBoot(): void {
  receiptSqlite("ensureSkillUpdateReceiptSchemaAtBoot");
}

export type SkillUpdateReceiptStatus =
  | "open"
  | "sealed"
  | "delivered"
  | "settled_no_row"
  | "undelivered";

/** What closed a receipt: the burst went quiet, or it ran into the cap. */
export type SkillUpdateReceiptSealedBy = "quiet" | "cap";

export interface SkillUpdateReceipt {
  id: string;
  status: SkillUpdateReceiptStatus;
  rev: number;
  firstEntryAt: number;
  lastEntryAt: number;
  sealedAt: number | null;
  sealedBy: SkillUpdateReceiptSealedBy | null;
  emitAttempts: number;
}

export interface SkillUpdateReceiptEntry {
  entryId: string;
  receiptId: string;
  skillId: string;
  name: string;
  changeSummary: string;
  sourceConversationId: string | null;
  runConversationId: string;
  createdAt: number;
}

/** One rewrite, as the producer records it. */
export interface SkillUpdateEntryInput {
  /**
   * Identity of the rewrite: the producing tool call, so a re-execution of
   * the same call records nothing new.
   */
  entryId: string;
  skillId: string;
  name: string;
  changeSummary: string;
  sourceConversationId?: string;
  runConversationId: string;
}

interface ReceiptRow {
  id: string;
  status: SkillUpdateReceiptStatus;
  rev: number;
  first_entry_at: number;
  last_entry_at: number;
  sealed_at: number | null;
  sealed_by: SkillUpdateReceiptSealedBy | null;
  emit_attempts: number;
}

interface EntryRow {
  entry_id: string;
  receipt_id: string;
  skill_id: string;
  name: string;
  change_summary: string;
  source_conversation_id: string | null;
  run_conversation_id: string;
  created_at: number;
}

function parseReceipt(row: ReceiptRow): SkillUpdateReceipt {
  return {
    id: row.id,
    status: row.status,
    rev: row.rev,
    firstEntryAt: row.first_entry_at,
    lastEntryAt: row.last_entry_at,
    sealedAt: row.sealed_at,
    sealedBy: row.sealed_by,
    emitAttempts: row.emit_attempts,
  };
}

function parseEntry(row: EntryRow): SkillUpdateReceiptEntry {
  return {
    entryId: row.entry_id,
    receiptId: row.receipt_id,
    skillId: row.skill_id,
    name: row.name,
    changeSummary: row.change_summary,
    sourceConversationId: row.source_conversation_id,
    runConversationId: row.run_conversation_id,
    createdAt: row.created_at,
  };
}

/**
 * How many times an append re-runs its transaction after losing the race to
 * open a receipt. The immediate transaction serializes writers, so the
 * unique index only trips when a writer's `BEGIN` beat the lock and the
 * other's commit; one re-run sees the winner. The bound keeps a pathological
 * connection from spinning.
 */
const OPEN_RACE_RETRIES = 3;

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/.test(err.message);
}

export type RecordSkillUpdateResult =
  | { recorded: true; receiptId: string; inserted: boolean }
  | { recorded: false; reason: string };

/**
 * Append one rewrite to the open receipt, opening one when none is.
 *
 * One immediate transaction: find or create the open receipt, insert the
 * entry unless its id is already stored, and if it was inserted, bump the
 * receipt's `rev` and `last_entry_at`. `inserted: false` reports a re-run of
 * the same tool call, which changes nothing.
 *
 * A failure is reported, never thrown: the caller has already written the
 * skill, and a receipt it cannot record is a receipt the user will not get,
 * not a reason to fail or retry the write. The caller logs and counts it.
 */
export function recordSkillUpdate(
  input: SkillUpdateEntryInput,
  now: number = Date.now(),
): RecordSkillUpdateResult {
  const raw = receiptSqlite("recordSkillUpdate");
  if (!raw) {
    return { recorded: false, reason: "memory database unavailable" };
  }
  const append = raw.transaction(
    (): { receiptId: string; inserted: boolean } => {
      // A replayed call whose entry already sits on a sealed receipt must
      // not open a fresh receipt just to discover the insert is a no-op: an
      // empty open receipt would carry the replay's stamp into the next
      // real burst.
      const existing = raw
        .query(
          /*sql*/ `SELECT receipt_id FROM ${ENTRIES_TABLE} WHERE entry_id = ?`,
        )
        .get(input.entryId) as { receipt_id: string } | null;
      if (existing) {
        return { receiptId: existing.receipt_id, inserted: false };
      }
      let receipt = raw
        .query(/*sql*/ `SELECT id FROM ${RECEIPTS_TABLE} WHERE status = 'open'`)
        .get() as { id: string } | null;
      if (!receipt) {
        receipt = { id: uuid() };
        raw
          .query(
            /*sql*/ `INSERT INTO ${RECEIPTS_TABLE}
            (id, status, rev, first_entry_at, last_entry_at, emit_attempts)
            VALUES (?, 'open', 0, ?, ?, 0)`,
          )
          .run(receipt.id, now, now);
      }
      raw
        .query(
          /*sql*/ `INSERT OR IGNORE INTO ${ENTRIES_TABLE}
          (entry_id, receipt_id, skill_id, name, change_summary,
           source_conversation_id, run_conversation_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.entryId,
          receipt.id,
          input.skillId,
          input.name,
          input.changeSummary,
          input.sourceConversationId ?? null,
          input.runConversationId,
          now,
        );
      const inserted =
        (raw.query(/*sql*/ `SELECT changes() AS n`).get() as { n: number }).n >
        0;
      if (inserted) {
        raw
          .query(
            /*sql*/ `UPDATE ${RECEIPTS_TABLE}
            SET rev = rev + 1, last_entry_at = ?
            WHERE id = ?`,
          )
          .run(now, receipt.id);
      }
      return { receiptId: receipt.id, inserted };
    },
  );

  let lastError: unknown;
  for (let attempt = 0; attempt <= OPEN_RACE_RETRIES; attempt += 1) {
    try {
      const result = append.immediate();
      return { recorded: true, ...result };
    } catch (err) {
      lastError = err;
      if (!isUniqueViolation(err)) {
        break;
      }
    }
  }
  const reason =
    lastError instanceof Error ? lastError.message : String(lastError);
  log.warn(
    { err: lastError, entryId: input.entryId, skillId: input.skillId },
    "skill update receipt recording failed",
  );
  return { recorded: false, reason };
}

/** The one open receipt, or null. */
export function readOpenSkillUpdateReceipt(): SkillUpdateReceipt | null {
  const raw = receiptSqlite("readOpenSkillUpdateReceipt");
  if (!raw) {
    return null;
  }
  const row = raw
    .query(/*sql*/ `SELECT * FROM ${RECEIPTS_TABLE} WHERE status = 'open'`)
    .get() as ReceiptRow | null;
  return row ? parseReceipt(row) : null;
}

/** One receipt by id, whatever its state, or null. */
export function readSkillUpdateReceipt(id: string): SkillUpdateReceipt | null {
  const raw = receiptSqlite("readSkillUpdateReceipt");
  if (!raw) {
    return null;
  }
  const row = raw
    .query(/*sql*/ `SELECT * FROM ${RECEIPTS_TABLE} WHERE id = ?`)
    .get(id) as ReceiptRow | null;
  return row ? parseReceipt(row) : null;
}

/** Sealed receipts awaiting delivery, oldest first. */
export function listSealedSkillUpdateReceipts(): SkillUpdateReceipt[] {
  const raw = receiptSqlite("listSealedSkillUpdateReceipts");
  if (!raw) {
    return [];
  }
  const rows = raw
    .query(
      /*sql*/ `SELECT * FROM ${RECEIPTS_TABLE}
        WHERE status = 'sealed' ORDER BY sealed_at ASC, id ASC`,
    )
    .all() as ReceiptRow[];
  return rows.map(parseReceipt);
}

/** Whether any receipt is open or sealed, so a tick is owed. */
export function hasUnsettledSkillUpdateReceipt(): boolean {
  const raw = receiptSqlite("hasUnsettledSkillUpdateReceipt");
  if (!raw) {
    return false;
  }
  const row = raw
    .query(
      /*sql*/ `SELECT 1 AS present FROM ${RECEIPTS_TABLE}
        WHERE status IN ('open', 'sealed') LIMIT 1`,
    )
    .get() as { present: number } | null;
  return row !== null;
}

/** A receipt's entries in the order the rewrites happened. */
export function listSkillUpdateReceiptEntries(
  receiptId: string,
): SkillUpdateReceiptEntry[] {
  const raw = receiptSqlite("listSkillUpdateReceiptEntries");
  if (!raw) {
    return [];
  }
  const rows = raw
    .query(
      /*sql*/ `SELECT * FROM ${ENTRIES_TABLE}
        WHERE receipt_id = ? ORDER BY created_at ASC, rowid ASC`,
    )
    .all(receiptId) as EntryRow[];
  return rows.map(parseEntry);
}

/**
 * Seal the open receipt. With `rev`, the seal succeeds only when no append
 * has landed since the caller read that revision; without it (the cap), it
 * seals whatever the receipt holds. Returns whether the seal landed.
 */
export function sealSkillUpdateReceipt(args: {
  id: string;
  rev: number | null;
  sealedBy: SkillUpdateReceiptSealedBy;
  now?: number;
}): boolean {
  const raw = receiptSqlite("sealSkillUpdateReceipt");
  if (!raw) {
    return false;
  }
  const now = args.now ?? Date.now();
  if (args.rev === null) {
    raw
      .query(
        /*sql*/ `UPDATE ${RECEIPTS_TABLE}
          SET status = 'sealed', sealed_at = ?, sealed_by = ?
          WHERE id = ? AND status = 'open'`,
      )
      .run(now, args.sealedBy, args.id);
  } else {
    raw
      .query(
        /*sql*/ `UPDATE ${RECEIPTS_TABLE}
          SET status = 'sealed', sealed_at = ?, sealed_by = ?
          WHERE id = ? AND status = 'open' AND rev = ?`,
      )
      .run(now, args.sealedBy, args.id, args.rev);
  }
  return (
    (raw.query(/*sql*/ `SELECT changes() AS n`).get() as { n: number }).n > 0
  );
}

/**
 * Count an emit attempt before it is made, so a crash between the emit and
 * the outcome being recorded still shows as an attempt on the next tick.
 * Returns the new count.
 */
export function countSkillUpdateReceiptEmitAttempt(id: string): number {
  const raw = receiptSqlite("countSkillUpdateReceiptEmitAttempt");
  if (!raw) {
    return 0;
  }
  raw
    .query(
      /*sql*/ `UPDATE ${RECEIPTS_TABLE}
        SET emit_attempts = emit_attempts + 1
        WHERE id = ? AND status = 'sealed'`,
    )
    .run(id);
  const row = raw
    .query(/*sql*/ `SELECT emit_attempts FROM ${RECEIPTS_TABLE} WHERE id = ?`)
    .get(id) as { emit_attempts: number } | null;
  return row?.emit_attempts ?? 0;
}

/**
 * Drop every entry a deleted conversation produced or was the source of,
 * and any receipt left with no entries. Called from the memory plugin's
 * `conversation-deleted` hook: the entries carry that conversation's id and
 * a summary distilled from it, and SQLite foreign keys cannot reach across
 * database files, so nothing cascades here on its own. A sealed receipt
 * emptied this way settles as `settled_no_row` on its next tick.
 */
export function purgeSkillUpdateReceiptEntriesForConversation(
  conversationId: string,
): void {
  const raw = receiptSqlite("purgeSkillUpdateReceiptEntriesForConversation");
  if (!raw) {
    return;
  }
  raw
    .query(
      /*sql*/ `DELETE FROM ${ENTRIES_TABLE}
        WHERE source_conversation_id = ? OR run_conversation_id = ?`,
    )
    .run(conversationId, conversationId);
  raw
    .query(
      /*sql*/ `DELETE FROM ${RECEIPTS_TABLE}
        WHERE NOT EXISTS (
          SELECT 1 FROM ${ENTRIES_TABLE} WHERE receipt_id = ${RECEIPTS_TABLE}.id
        )`,
    )
    .run();
}

/** Drop every receipt and entry; the clear-all reset orphans them all. */
export function clearAllSkillUpdateReceipts(): void {
  const raw = receiptSqlite("clearAllSkillUpdateReceipts");
  if (!raw) {
    return;
  }
  raw.exec(
    /*sql*/ `DELETE FROM ${ENTRIES_TABLE}; DELETE FROM ${RECEIPTS_TABLE};`,
  );
}

/** Move a sealed receipt to its terminal state. */
export function settleSkillUpdateReceipt(args: {
  id: string;
  status: Exclude<SkillUpdateReceiptStatus, "open" | "sealed">;
  reason?: string;
  now?: number;
}): void {
  const raw = receiptSqlite("settleSkillUpdateReceipt");
  if (!raw) {
    return;
  }
  raw
    .query(
      /*sql*/ `UPDATE ${RECEIPTS_TABLE}
        SET status = ?, settled_at = ?, settled_reason = ?
        WHERE id = ? AND status = 'sealed'`,
    )
    .run(args.status, args.now ?? Date.now(), args.reason ?? null, args.id);
}
