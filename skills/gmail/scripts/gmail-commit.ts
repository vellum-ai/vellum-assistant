#!/usr/bin/env bun

/**
 * Gmail operation commit/cancel.
 * Subcommands:
 *   commit <run-id> — Execute all staged ops from a dry-run
 *   cancel <run-id> — Delete the run log without executing anything
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  parseArgs,
  printError,
  ok,
  optionalArg,
} from "./lib/common.js";
import { gmailPost, DailyQuotaExceededError } from "./lib/gmail-client.js";
import {
  readLog,
  runExists,
  writeCommitted,
  writeFailed,
  writeInterrupted,
  writeCompleted,
  summarizeRun,
  type OpEntry,
} from "./lib/op-log.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKILL_ROOT = path.resolve(import.meta.dir, "..");
const OPS_DIR = path.join(SKILL_ROOT, "data", "ops");

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

async function commitRun(
  runId: string,
  account?: string,
): Promise<void> {
  if (!runExists(runId)) {
    printError(`Run not found: ${runId}`);
    return;
  }

  const entries = readLog(runId);

  // Collect committed chunk indexes to skip
  const alreadyCommitted = new Set<number>();
  const alreadyFailed = new Set<number>();
  for (const entry of entries) {
    if (entry.status === "committed" && entry.chunk_index !== undefined) {
      alreadyCommitted.add(entry.chunk_index);
    }
    if (entry.status === "failed" && entry.chunk_index !== undefined) {
      alreadyFailed.add(entry.chunk_index);
    }
  }

  // Find staged entries that haven't been committed or failed
  const staged = entries.filter(
    (e): e is OpEntry & { chunk_index: number; message_ids: string[] } =>
      e.status === "staged" &&
      e.op !== undefined &&
      e.chunk_index !== undefined &&
      e.message_ids !== undefined &&
      !alreadyCommitted.has(e.chunk_index) &&
      !alreadyFailed.has(e.chunk_index),
  );

  if (staged.length === 0) {
    ok({
      committed: 0,
      failed: 0,
      run_id: runId,
      note: "No staged operations to commit",
      summary: summarizeRun(runId),
    });
    return;
  }

  let committed = 0;
  let failed = 0;

  for (const entry of staged) {
    try {
      if (entry.op === "archive") {
        const resp = await gmailPost(
          "/messages/batchModify",
          { ids: entry.message_ids, removeLabelIds: ["INBOX"] },
          account,
        );
        if (!resp.ok) {
          const errMsg = `batchModify failed (status ${resp.status}): ${JSON.stringify(resp.data)}`;
          writeFailed(runId, entry.chunk_index, errMsg);
          failed++;
          continue;
        }
      } else if (entry.op === "label_add" || entry.op === "label_remove") {
        // Label ops store label info in the reason field as "label:<action>:<labelIds>"
        const labelParts = entry.reason?.split(":") ?? [];
        const labelAction = labelParts[1]; // "add" or "remove"
        const labelIds = labelParts.slice(2);
        const body =
          labelAction === "add"
            ? { ids: entry.message_ids, addLabelIds: labelIds }
            : { ids: entry.message_ids, removeLabelIds: labelIds };
        const resp = await gmailPost("/messages/batchModify", body, account);
        if (!resp.ok) {
          const errMsg = `label batchModify failed (status ${resp.status})`;
          writeFailed(runId, entry.chunk_index, errMsg);
          failed++;
          continue;
        }
      } else if (entry.op === "filter_create") {
        // Filter ops store criteria in the reason field as JSON
        const filterData = entry.reason
          ? JSON.parse(entry.reason)
          : null;
        if (filterData) {
          const resp = await gmailPost(
            "/settings/filters",
            filterData,
            account,
          );
          if (!resp.ok) {
            const errMsg = `filter create failed (status ${resp.status})`;
            writeFailed(runId, entry.chunk_index, errMsg);
            failed++;
            continue;
          }
        }
      }

      writeCommitted(runId, entry.chunk_index);
      committed++;
    } catch (err) {
      if (err instanceof DailyQuotaExceededError) {
        writeInterrupted({
          run_id: runId,
          reason: "daily_quota",
          resume_hint: "Resume after midnight PT",
        });
        ok({
          interrupted: true,
          run_id: runId,
          committed,
          failed,
          note: "Daily quota exceeded. Resume with: bun run scripts/gmail-commit.ts commit " + runId,
        });
        return;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      writeFailed(runId, entry.chunk_index, errMsg);
      failed++;
    }
  }

  writeCompleted(runId, committed, failed);
  ok({
    committed,
    failed,
    run_id: runId,
    summary: summarizeRun(runId),
  });
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

function cancelRun(runId: string): void {
  const logPath = path.join(OPS_DIR, `${runId}.jsonl`);
  if (!fs.existsSync(logPath)) {
    printError(`Run not found: ${runId}`);
    return;
  }

  fs.unlinkSync(logPath);
  ok({ cancelled: true, run_id: runId });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const subcommand = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  const runId = optionalArg(args, "run-id") ?? process.argv[3];

  switch (subcommand) {
    case "commit": {
      if (!runId || runId.startsWith("--")) {
        printError("Usage: gmail-commit.ts commit --run-id <run-id>");
        return;
      }
      const account = optionalArg(args, "account");
      await commitRun(runId, account);
      break;
    }
    case "cancel": {
      if (!runId || runId.startsWith("--")) {
        printError("Usage: gmail-commit.ts cancel --run-id <run-id>");
        return;
      }
      cancelRun(runId);
      break;
    }
    default:
      printError(
        `Unknown subcommand: "${subcommand ?? "(none)"}". Use "commit" or "cancel".`,
      );
  }
}

if (import.meta.main) {
  main().catch((err) => {
    printError(err instanceof Error ? err.message : String(err));
  });
}
