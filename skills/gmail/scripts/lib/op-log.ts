#!/usr/bin/env bun

/**
 * Gmail operation log — append-only JSONL journal for destructive operations.
 *
 * Every archive/label/filter/trash operation writes a `staged` entry before
 * the API call and a `committed` or `failed` entry after. This enables:
 *   - Resumability: load the log, skip committed ops, retry staged/failed
 *   - Audit trail: every destructive action is recorded with reason + metadata
 *   - Dry-run (PR 2): write staged entries without executing
 *   - Reversal (PR 3): read committed entries and apply inverse operations
 *
 * Log location: skills/gmail/data/ops/<run-id>.jsonl
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKILL_ROOT = path.resolve(import.meta.dir, "../..");
const OPS_DIR = path.join(SKILL_ROOT, "data", "ops");

/** How many days to retain op logs before pruning. */
const RETENTION_DAYS = 30;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OpStatus =
  | "staged"
  | "committed"
  | "failed"
  | "interrupted"
  | "completed";

export type OpType =
  | "archive"
  | "label_add"
  | "label_remove"
  | "filter_create"
  | "trash";

export interface OpEntry {
  ts: string;
  run_id: string;
  /** The pipeline phase that produced this op. */
  phase?: string;
  /** The destructive operation type. */
  op?: OpType;
  /** Index of the batch chunk (for archive operations). */
  chunk_index?: number;
  /** Gmail message IDs affected by this op. */
  message_ids?: string[];
  /** Human-readable reason this op was triggered. */
  reason?: string;
  /** Sender "from" header for audit purposes. */
  from?: string;
  /** Email subject for audit purposes. */
  subject?: string;
  /** Lifecycle status. */
  status: OpStatus;
  /** Error message (when status = "failed"). */
  error?: string;
  /** Interruption reason (when status = "interrupted"). */
  interrupt_reason?: string;
  /** Hint for when to resume (e.g. "after midnight PT"). */
  resume_hint?: string;
  /** Checkpoint data for resuming pagination. */
  checkpoint?: CheckpointData;
  /** Total ops committed (when status = "completed"). */
  total_committed?: number;
  /** Total ops failed (when status = "completed"). */
  total_failed?: number;
}

export interface CheckpointData {
  page_token?: string;
  processed_count: number;
  query?: string;
}

export interface RunSummary {
  run_id: string;
  started_at: string;
  status: "in_progress" | "interrupted" | "completed";
  phases: Record<string, { staged: number; committed: number; failed: number }>;
  total_staged: number;
  total_committed: number;
  total_failed: number;
  interrupt_reason?: string;
}

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

function ensureOpsDir(): void {
  fs.mkdirSync(OPS_DIR, { recursive: true });
}

function logPath(runId: string): string {
  return path.join(OPS_DIR, `${runId}.jsonl`);
}

// ---------------------------------------------------------------------------
// Run ID generation
// ---------------------------------------------------------------------------

/** Generate a new run ID using crypto.randomUUID with a timestamp prefix. */
export function generateRunId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const uuid = crypto.randomUUID().slice(0, 8);
  return `run_${ts}_${uuid}`;
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/** Append a single op entry to the run's JSONL log. */
export function appendOp(entry: OpEntry): void {
  ensureOpsDir();
  const line = JSON.stringify(entry) + "\n";
  fs.appendFileSync(logPath(entry.run_id), line);
}

/** Write a staged entry before executing a destructive operation. */
export function writeStaged(opts: {
  run_id: string;
  phase?: string;
  op: OpType;
  chunk_index: number;
  message_ids: string[];
  reason?: string;
  from?: string;
  subject?: string;
}): void {
  appendOp({
    ts: new Date().toISOString(),
    run_id: opts.run_id,
    phase: opts.phase,
    op: opts.op,
    chunk_index: opts.chunk_index,
    message_ids: opts.message_ids,
    reason: opts.reason,
    from: opts.from,
    subject: opts.subject,
    status: "staged",
  });
}

/** Write a committed entry after a successful API call. */
export function writeCommitted(run_id: string, chunk_index: number): void {
  appendOp({
    ts: new Date().toISOString(),
    run_id,
    chunk_index,
    status: "committed",
  });
}

/** Write a failed entry after a failed API call. */
export function writeFailed(
  run_id: string,
  chunk_index: number,
  error: string,
): void {
  appendOp({
    ts: new Date().toISOString(),
    run_id,
    chunk_index,
    status: "failed",
    error,
  });
}

/** Write an interrupted entry when a run is halted (e.g. daily quota). */
export function writeInterrupted(opts: {
  run_id: string;
  reason: string;
  resume_hint?: string;
  checkpoint?: CheckpointData;
}): void {
  appendOp({
    ts: new Date().toISOString(),
    run_id: opts.run_id,
    status: "interrupted",
    interrupt_reason: opts.reason,
    resume_hint: opts.resume_hint,
    checkpoint: opts.checkpoint,
  });
}

/** Write a checkpoint entry for pagination state. */
export function writeCheckpoint(
  run_id: string,
  checkpoint: CheckpointData,
): void {
  appendOp({
    ts: new Date().toISOString(),
    run_id,
    status: "staged",
    checkpoint,
  });
}

/** Write a completion entry summarizing the run. */
export function writeCompleted(
  run_id: string,
  total_committed: number,
  total_failed: number,
): void {
  appendOp({
    ts: new Date().toISOString(),
    run_id,
    status: "completed",
    total_committed,
    total_failed,
  });
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/** Read all entries from a run's JSONL log. */
export function readLog(runId: string): OpEntry[] {
  const p = logPath(runId);
  if (!fs.existsSync(p)) return [];
  const content = fs.readFileSync(p, "utf-8");
  return content
    .split("\n")
    .filter((line: string) => line.trim().length > 0)
    .map((line: string) => JSON.parse(line) as OpEntry);
}

/** Check if a run log exists. */
export function runExists(runId: string): boolean {
  return fs.existsSync(logPath(runId));
}

/** Get the set of chunk indexes that have been committed. */
export function getCommittedChunks(runId: string): Set<number> {
  const entries = readLog(runId);
  const committed = new Set<number>();
  for (const entry of entries) {
    if (entry.status === "committed" && entry.chunk_index !== undefined) {
      committed.add(entry.chunk_index);
    }
  }
  return committed;
}

/** Get the latest checkpoint from a run log. */
export function getLatestCheckpoint(
  runId: string,
): CheckpointData | undefined {
  const entries = readLog(runId);
  let latest: CheckpointData | undefined;
  for (const entry of entries) {
    if (entry.checkpoint) {
      latest = entry.checkpoint;
    }
  }
  return latest;
}

/** Get all staged entries that have NOT been committed or failed. */
export function getPendingOps(runId: string): OpEntry[] {
  const entries = readLog(runId);
  const resolved = new Set<number>();
  for (const entry of entries) {
    if (
      (entry.status === "committed" || entry.status === "failed") &&
      entry.chunk_index !== undefined
    ) {
      resolved.add(entry.chunk_index);
    }
  }
  return entries.filter(
    (e) =>
      e.status === "staged" &&
      e.chunk_index !== undefined &&
      !resolved.has(e.chunk_index),
  );
}

/** Summarize a run's log into counts by phase. */
export function summarizeRun(runId: string): RunSummary | null {
  const entries = readLog(runId);
  if (entries.length === 0) return null;

  const phases: Record<
    string,
    { staged: number; committed: number; failed: number }
  > = {};
  let totalStaged = 0;
  let totalCommitted = 0;
  let totalFailed = 0;
  let startedAt = "";
  let status: RunSummary["status"] = "in_progress";
  let interruptReason: string | undefined;

  for (const entry of entries) {
    if (!startedAt && entry.ts) startedAt = entry.ts;

    if (entry.status === "completed") {
      status = "completed";
      continue;
    }
    if (entry.status === "interrupted") {
      status = "interrupted";
      interruptReason = entry.interrupt_reason;
      continue;
    }

    const phase = entry.phase ?? "unknown";
    if (!phases[phase]) {
      phases[phase] = { staged: 0, committed: 0, failed: 0 };
    }

    if (entry.status === "staged" && entry.op) {
      phases[phase].staged++;
      totalStaged++;
    } else if (entry.status === "committed") {
      phases[phase].committed++;
      totalCommitted++;
    } else if (entry.status === "failed") {
      phases[phase].failed++;
      totalFailed++;
    }
  }

  return {
    run_id: runId,
    started_at: startedAt,
    status,
    phases,
    total_staged: totalStaged,
    total_committed: totalCommitted,
    total_failed: totalFailed,
    interrupt_reason: interruptReason,
  };
}

// ---------------------------------------------------------------------------
// Dry-run summary
// ---------------------------------------------------------------------------

export interface DryRunSummary {
  run_id: string;
  total_ops: number;
  by_op: Record<string, number>;
  by_phase: Record<string, { count: number; examples: string[] }>;
}

/** Build a summary suitable for dry-run output — counts by op type and phase with examples. */
export function summarizeDryRun(runId: string): DryRunSummary | null {
  const entries = readLog(runId);
  if (entries.length === 0) return null;

  const byOp: Record<string, number> = {};
  const byPhase: Record<string, { count: number; examples: string[] }> = {};
  let totalOps = 0;

  for (const entry of entries) {
    if (entry.status !== "staged" || !entry.op) continue;
    totalOps++;

    const opKey = entry.op;
    byOp[opKey] = (byOp[opKey] ?? 0) + 1;

    const phase = entry.phase ?? "unknown";
    if (!byPhase[phase]) {
      byPhase[phase] = { count: 0, examples: [] };
    }
    byPhase[phase].count++;

    // Collect up to 3 example descriptions per phase
    if (byPhase[phase].examples.length < 3) {
      const desc = [entry.from, entry.subject, entry.reason]
        .filter(Boolean)
        .join(" — ");
      if (desc) byPhase[phase].examples.push(desc);
    }
  }

  return { run_id: runId, total_ops: totalOps, by_op: byOp, by_phase: byPhase };
}

// ---------------------------------------------------------------------------
// Listing & pruning
// ---------------------------------------------------------------------------

/** List all run IDs, most recent first. */
export function listRuns(): string[] {
  ensureOpsDir();
  const files = fs
    .readdirSync(OPS_DIR)
    .filter((f: string) => f.endsWith(".jsonl"));
  // Sort by modification time, newest first
  return files
    .map((f: string) => ({
      name: f.replace(".jsonl", ""),
      mtime: fs.statSync(path.join(OPS_DIR, f)).mtimeMs,
    }))
    .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime)
    .map((f: { name: string }) => f.name);
}

/** Delete op logs older than RETENTION_DAYS. */
export function pruneOldRuns(): number {
  ensureOpsDir();
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const files = fs
    .readdirSync(OPS_DIR)
    .filter((f: string) => f.endsWith(".jsonl"));
  let pruned = 0;
  for (const file of files) {
    const filePath = path.join(OPS_DIR, file);
    const stat = fs.statSync(filePath);
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(filePath);
      pruned++;
    }
  }
  return pruned;
}

/** Find the most recent interrupted run, if any. */
export function findInterruptedRun(): string | null {
  const runs = listRuns();
  for (const runId of runs) {
    const summary = summarizeRun(runId);
    if (summary?.status === "interrupted") {
      return runId;
    }
  }
  return null;
}
