#!/usr/bin/env bun

/**
 * Gmail operation reversal.
 * Reads committed entries from an op log and applies inverse operations.
 *
 * Subcommands:
 *   reverse --run-id <id>                    — Reverse all committed ops in a run
 *   reverse --run-id <id> --thread <id>      — Reverse a specific thread only
 */

import {
  parseArgs,
  printError,
  ok,
  optionalArg,
} from "./lib/common.js";
import { gmailPost, DailyQuotaExceededError } from "./lib/gmail-client.js";
import {
  generateRunId,
  readLog,
  runExists,
  writeStaged,
  writeCommitted,
  writeFailed,
  writeInterrupted,
  writeCompleted,
  summarizeRun,
  type OpEntry,
} from "./lib/op-log.js";

// ---------------------------------------------------------------------------
// UI confirmation helper
// ---------------------------------------------------------------------------

async function requestConfirmation(opts: {
  title: string;
  message: string;
  confirmLabel?: string;
}): Promise<boolean> {
  const args = [
    "assistant",
    "ui",
    "confirm",
    "--title",
    opts.title,
    "--message",
    opts.message,
    "--confirm-label",
    opts.confirmLabel ?? "Confirm",
    "--json",
  ];

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  try {
    const result = JSON.parse(stdout);
    return result.ok === true && result.confirmed === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Reversal logic
// ---------------------------------------------------------------------------

interface CommittedOp {
  chunk_index: number;
  op: string;
  message_ids: string[];
  reason?: string;
  phase?: string;
}

/**
 * Get all committed operations from a run log.
 * Returns only entries that have both a staged op and a committed confirmation.
 */
function getCommittedOps(runId: string): CommittedOp[] {
  const entries = readLog(runId);

  // Build map of staged ops by chunk_index
  const stagedByChunk = new Map<number, OpEntry>();
  const committedChunks = new Set<number>();

  for (const entry of entries) {
    if (
      entry.status === "staged" &&
      entry.op &&
      entry.chunk_index !== undefined
    ) {
      stagedByChunk.set(entry.chunk_index, entry);
    }
    if (entry.status === "committed" && entry.chunk_index !== undefined) {
      committedChunks.add(entry.chunk_index);
    }
  }

  const result: CommittedOp[] = [];
  for (const chunkIndex of committedChunks) {
    const staged = stagedByChunk.get(chunkIndex);
    if (staged && staged.message_ids) {
      result.push({
        chunk_index: chunkIndex,
        op: staged.op!,
        message_ids: staged.message_ids,
        reason: staged.reason,
        phase: staged.phase,
      });
    }
  }

  return result;
}

/**
 * Reverse a single committed op by applying its inverse.
 */
async function reverseOp(
  op: CommittedOp,
  reversalRunId: string,
  chunkIndex: number,
  account?: string,
): Promise<boolean> {
  writeStaged({
    run_id: reversalRunId,
    phase: `reversal:${op.phase ?? "unknown"}`,
    op: op.op === "archive" ? "archive" : (op.op as any),
    chunk_index: chunkIndex,
    message_ids: op.message_ids,
    reason: `reverse:${op.reason ?? "unknown"}`,
  });

  try {
    if (op.op === "archive") {
      // Inverse of archive: add INBOX label back
      const resp = await gmailPost(
        "/messages/batchModify",
        { ids: op.message_ids, addLabelIds: ["INBOX"] },
        account,
      );
      if (!resp.ok) {
        const errMsg = `unarchive batchModify failed (status ${resp.status})`;
        writeFailed(reversalRunId, chunkIndex, errMsg);
        return false;
      }
    } else if (op.op === "label_add") {
      // Inverse: remove the labels that were added
      const labelParts = op.reason?.split(":") ?? [];
      const labelIds = labelParts.slice(2);
      if (labelIds.length > 0) {
        const resp = await gmailPost(
          "/messages/batchModify",
          { ids: op.message_ids, removeLabelIds: labelIds },
          account,
        );
        if (!resp.ok) {
          writeFailed(reversalRunId, chunkIndex, `reverse label_add failed (status ${resp.status})`);
          return false;
        }
      }
    } else if (op.op === "label_remove") {
      // Inverse: add back the labels that were removed
      const labelParts = op.reason?.split(":") ?? [];
      const labelIds = labelParts.slice(2);
      if (labelIds.length > 0) {
        const resp = await gmailPost(
          "/messages/batchModify",
          { ids: op.message_ids, addLabelIds: labelIds },
          account,
        );
        if (!resp.ok) {
          writeFailed(reversalRunId, chunkIndex, `reverse label_remove failed (status ${resp.status})`);
          return false;
        }
      }
    } else if (op.op === "filter_create") {
      // Filter reversal requires the filterId which we may not have stored.
      // Log as failed with explanation.
      writeFailed(
        reversalRunId,
        chunkIndex,
        "filter_create reversal not supported — delete filter manually via gmail-manage.ts filters --action delete --filter-id <id>",
      );
      return false;
    } else if (op.op === "trash") {
      // Inverse of trash: remove TRASH label, add INBOX
      const resp = await gmailPost(
        "/messages/batchModify",
        { ids: op.message_ids, removeLabelIds: ["TRASH"], addLabelIds: ["INBOX"] },
        account,
      );
      if (!resp.ok) {
        writeFailed(reversalRunId, chunkIndex, `untrash batchModify failed (status ${resp.status})`);
        return false;
      }
    }

    writeCommitted(reversalRunId, chunkIndex);
    return true;
  } catch (err) {
    if (err instanceof DailyQuotaExceededError) {
      writeInterrupted({
        run_id: reversalRunId,
        reason: "daily_quota",
        resume_hint: "Resume after midnight PT",
      });
      throw err;
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    writeFailed(reversalRunId, chunkIndex, errMsg);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main reversal commands
// ---------------------------------------------------------------------------

async function reverseRun(
  originalRunId: string,
  threadFilter?: string,
  account?: string,
): Promise<void> {
  if (!runExists(originalRunId)) {
    printError(`Run not found: ${originalRunId}`);
    return;
  }

  const committedOps = getCommittedOps(originalRunId);
  if (committedOps.length === 0) {
    ok({
      reversed: false,
      run_id: originalRunId,
      note: "No committed operations to reverse",
    });
    return;
  }

  // If thread filter is specified, narrow to ops containing that thread's messages
  let opsToReverse = committedOps;
  if (threadFilter) {
    // Thread filter matches against message IDs — the user provides a thread ID
    // which we check against the stored message IDs
    opsToReverse = committedOps
      .map((op) => ({
        ...op,
        message_ids: op.message_ids.filter((id) => id === threadFilter),
      }))
      .filter((op) => op.message_ids.length > 0);

    if (opsToReverse.length === 0) {
      ok({
        reversed: false,
        run_id: originalRunId,
        note: `No committed operations found for thread/message: ${threadFilter}`,
      });
      return;
    }
  }

  // Require confirmation for bulk reversal (skip for single-thread)
  if (!threadFilter) {
    const totalMessages = opsToReverse.reduce(
      (sum, op) => sum + op.message_ids.length,
      0,
    );
    const confirmed = await requestConfirmation({
      title: "Reverse run",
      message: `Reverse ${opsToReverse.length} operation(s) affecting ~${totalMessages} message(s) from run ${originalRunId}?`,
      confirmLabel: "Reverse",
    });
    if (!confirmed) {
      ok({ reversed: false, reason: "User did not confirm" });
      return;
    }
  }

  const reversalRunId = generateRunId();
  let committed = 0;
  let failed = 0;

  for (let i = 0; i < opsToReverse.length; i++) {
    const success = await reverseOp(opsToReverse[i], reversalRunId, i, account);
    if (success) {
      committed++;
    } else {
      failed++;
    }
  }

  writeCompleted(reversalRunId, committed, failed);

  ok({
    reversed: true,
    original_run_id: originalRunId,
    reversal_run_id: reversalRunId,
    committed,
    failed,
    summary: summarizeRun(reversalRunId),
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const runId = optionalArg(args, "run-id");
  if (!runId) {
    printError("Usage: gmail-reverse.ts --run-id <run-id> [--thread <message-id>]");
    return;
  }

  const threadFilter = optionalArg(args, "thread");
  const account = optionalArg(args, "account");

  await reverseRun(runId, threadFilter, account);
}

if (import.meta.main) {
  main().catch((err) => {
    if (err instanceof DailyQuotaExceededError) {
      ok({
        interrupted: true,
        reason: "daily_quota",
        note: "Gmail daily quota exceeded. Resume reversal after midnight PT.",
      });
      return;
    }
    printError(err instanceof Error ? err.message : String(err));
  });
}
