#!/usr/bin/env bun

/**
 * Gmail archive operations.
 * Supports 4 resolution paths: --query, --cache-key + --sender-emails,
 * --message-ids (batch), and --message-id (single).
 */

import {
  parseArgs,
  printError,
  ok,
  optionalArg,
  parseCsv,
} from "./lib/common.js";
import { gmailGet, gmailPost, DailyQuotaExceededError } from "./lib/gmail-client.js";
import { addToBlocklist } from "./gmail-prefs.js";
import {
  generateRunId,
  writeStaged,
  writeCommitted,
  writeFailed,
  writeInterrupted,
  writeCheckpoint,
  writeCompleted,
  summarizeRun,
  summarizeDryRun,
  getPendingOps,
  runExists,
} from "./lib/op-log.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_MODIFY_LIMIT = 1000;
const MAX_MESSAGES = 5000;

// ---------------------------------------------------------------------------
// UI confirmation helper
// ---------------------------------------------------------------------------

/**
 * Request user confirmation via `assistant ui confirm`.
 * Blocks until the user approves, denies, or the request times out.
 */
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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Persist archived sender emails to the blocklist.
 * Filters for valid email addresses and wraps in try/catch for non-fatal errors.
 */
function recordBlocklist(senderEmails: string[]): void {
  const validEmails = senderEmails.filter((e) => e.includes("@"));
  if (validEmails.length === 0) return;

  try {
    addToBlocklist(validEmails);
  } catch {
    // Non-fatal — preferences are best-effort
  }
}

/**
 * Batch modify messages in chunks of BATCH_MODIFY_LIMIT.
 * Each chunk is logged to the op log before execution for resumability.
 * In dry-run mode, writes staged entries but skips all API calls.
 */
async function batchArchive(
  messageIds: string[],
  account?: string,
  opts?: { runId?: string; phase?: string; reason?: string; dryRun?: boolean },
): Promise<{ runId: string; committed: number; failed: number; staged: number }> {
  const runId = opts?.runId ?? generateRunId();
  let committed = 0;
  let failed = 0;
  let staged = 0;

  for (let i = 0; i < messageIds.length; i += BATCH_MODIFY_LIMIT) {
    const chunkIndex = Math.floor(i / BATCH_MODIFY_LIMIT);
    const chunk = messageIds.slice(i, i + BATCH_MODIFY_LIMIT);

    writeStaged({
      run_id: runId,
      phase: opts?.phase,
      op: "archive",
      chunk_index: chunkIndex,
      message_ids: chunk,
      reason: opts?.reason,
    });
    staged++;

    // In dry-run mode, only stage — don't execute
    if (opts?.dryRun) continue;

    try {
      const resp = await gmailPost(
        "/messages/batchModify",
        { ids: chunk, removeLabelIds: ["INBOX"] },
        account,
      );
      if (!resp.ok) {
        const errMsg = `batchModify failed (status ${resp.status}): ${JSON.stringify(resp.data)}`;
        writeFailed(runId, chunkIndex, errMsg);
        failed++;
        continue;
      }
      writeCommitted(runId, chunkIndex);
      committed++;
    } catch (err) {
      if (err instanceof DailyQuotaExceededError) {
        writeInterrupted({
          run_id: runId,
          reason: "daily_quota",
          resume_hint: "Resume after midnight PT",
          checkpoint: { processed_count: i, query: opts?.reason },
        });
        throw err;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      writeFailed(runId, chunkIndex, errMsg);
      failed++;
    }
  }

  if (!opts?.dryRun) {
    writeCompleted(runId, committed, failed);
  }
  return { runId, committed, failed, staged };
}

/** Checkpoint interval — write pagination state every N IDs. */
const CHECKPOINT_INTERVAL = 500;

/**
 * Paginate Gmail message search, collecting all message IDs up to MAX_MESSAGES.
 * Supports resuming from a page token and writes checkpoints for resumability.
 */
async function collectMessageIds(
  query: string,
  account?: string,
  opts?: { runId?: string; startPageToken?: string },
): Promise<string[]> {
  const allIds: string[] = [];
  let pageToken: string | undefined = opts?.startPageToken;

  while (allIds.length < MAX_MESSAGES) {
    const remaining = MAX_MESSAGES - allIds.length;
    const queryParams: Record<string, string> = {
      q: query,
      maxResults: String(Math.min(500, remaining)),
    };
    if (pageToken) queryParams.pageToken = pageToken;

    const resp = await gmailGet<{
      messages?: Array<{ id: string }>;
      nextPageToken?: string;
    }>("/messages", queryParams, account);

    if (!resp.ok) {
      throw new Error(
        `Gmail search failed (status ${resp.status}): ${JSON.stringify(resp.data)}`,
      );
    }

    const ids = (resp.data.messages ?? []).map((m) => m.id);
    if (ids.length === 0) break;

    allIds.push(...ids.slice(0, remaining));

    pageToken = resp.data.nextPageToken ?? undefined;

    // Write a checkpoint every CHECKPOINT_INTERVAL IDs
    if (opts?.runId && allIds.length % CHECKPOINT_INTERVAL < ids.length) {
      writeCheckpoint(opts.runId, {
        page_token: pageToken,
        processed_count: allIds.length,
        query,
      });
    }

    if (!pageToken) break;
  }

  return allIds;
}

// ---------------------------------------------------------------------------
// Resolution paths
// ---------------------------------------------------------------------------

/** Path 1: --query — search Gmail and archive all matching messages. */
async function archiveByQuery(
  query: string,
  account?: string,
  skipConfirm?: boolean,
  runId?: string,
  phase?: string,
  dryRun?: boolean,
): Promise<void> {
  const rid = runId ?? generateRunId();

  if (!dryRun && !skipConfirm) {
    const confirmed = await requestConfirmation({
      title: "Archive messages",
      message: `Archive all messages matching query: ${query}`,
      confirmLabel: "Archive",
    });
    if (!confirmed) {
      ok({ archived: 0, method: "query", reason: "User did not confirm" });
      return;
    }
  }

  const messageIds = await collectMessageIds(query, account, { runId: rid });

  if (messageIds.length === 0) {
    ok({ archived: 0, method: "query", note: "No messages matched the query" });
    return;
  }

  const result = await batchArchive(messageIds, account, {
    runId: rid,
    phase,
    reason: `query:${query}`,
    dryRun,
  });

  if (dryRun) {
    const summary = summarizeDryRun(rid);
    ok({
      dry_run: true,
      run_id: result.runId,
      would_archive: messageIds.length,
      method: "query",
      summary,
      commit_command: `bun run scripts/gmail-commit.ts commit --run-id ${result.runId}`,
      cancel_command: `bun run scripts/gmail-commit.ts cancel --run-id ${result.runId}`,
    });
  } else {
    ok({
      archived: messageIds.length,
      method: "query",
      run_id: result.runId,
      committed: result.committed,
      failed: result.failed,
    });
  }
}

/** Path 2: --cache-key + --sender-emails — retrieve from cache, fall back to per-sender query. */
async function archiveByCacheKey(
  cacheKey: string,
  senderEmails: string[],
  account?: string,
  skipConfirm?: boolean,
  runId?: string,
  phase?: string,
  dryRun?: boolean,
): Promise<void> {
  const rid = runId ?? generateRunId();

  if (!dryRun && !skipConfirm) {
    const confirmed = await requestConfirmation({
      title: "Archive messages",
      message: `Archive messages from ${senderEmails.length} sender(s)`,
      confirmLabel: "Archive",
    });
    if (!confirmed) {
      ok({ archived: 0, method: "cache", reason: "User did not confirm" });
      return;
    }
  }

  // Attempt to retrieve cached data
  let cachedData: Record<string, string[]> | null = null;

  try {
    const proc = Bun.spawn(["assistant", "cache", "get", cacheKey, "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    const parsed = JSON.parse(stdout);
    if (
      parsed.ok === true &&
      parsed.data !== null &&
      parsed.data !== undefined
    ) {
      cachedData = parsed.data as Record<string, string[]>;
    }
  } catch {
    // Cache miss — will fall back to per-sender query
  }

  const allMessageIds: string[] = [];

  if (cachedData !== null) {
    // Look up message IDs for each sender email from the cached data
    for (const email of senderEmails) {
      const ids = cachedData[email];
      if (Array.isArray(ids)) {
        allMessageIds.push(...ids);
      }
    }
  }

  if (cachedData === null || allMessageIds.length === 0) {
    // Fall back to per-sender query-based archiving
    for (const email of senderEmails) {
      const sanitized = email.replace(/"/g, "");
      const query = `from:"${sanitized}" in:inbox`;
      const ids = await collectMessageIds(query, account, { runId: rid });
      allMessageIds.push(...ids);
      if (allMessageIds.length >= MAX_MESSAGES) break;
    }
  }

  if (allMessageIds.length === 0) {
    ok({ archived: 0, method: "cache", note: "No messages found" });
    return;
  }

  const result = await batchArchive(allMessageIds, account, {
    runId: rid,
    phase,
    reason: `cache:${senderEmails.join(",")}`,
    dryRun,
  });

  if (dryRun) {
    const summary = summarizeDryRun(rid);
    ok({
      dry_run: true,
      run_id: result.runId,
      would_archive: allMessageIds.length,
      method: "cache",
      summary,
      commit_command: `bun run scripts/gmail-commit.ts commit --run-id ${result.runId}`,
      cancel_command: `bun run scripts/gmail-commit.ts cancel --run-id ${result.runId}`,
    });
  } else {
    recordBlocklist(senderEmails);
    ok({
      archived: allMessageIds.length,
      method: "cache",
      run_id: result.runId,
      committed: result.committed,
      failed: result.failed,
    });
  }
}

/** Path 3: --message-ids — direct batch archive. */
async function archiveByMessageIds(
  messageIds: string[],
  account?: string,
  skipConfirm?: boolean,
  runId?: string,
  phase?: string,
  dryRun?: boolean,
): Promise<void> {
  const rid = runId ?? generateRunId();

  if (!dryRun && !skipConfirm) {
    const confirmed = await requestConfirmation({
      title: "Archive messages",
      message: `Archive ${messageIds.length} message(s)`,
      confirmLabel: "Archive",
    });
    if (!confirmed) {
      ok({ archived: 0, method: "batch", reason: "User did not confirm" });
      return;
    }
  }

  const result = await batchArchive(messageIds, account, {
    runId: rid,
    phase,
    reason: `batch:${messageIds.length} messages`,
    dryRun,
  });

  if (dryRun) {
    const summary = summarizeDryRun(rid);
    ok({
      dry_run: true,
      run_id: result.runId,
      would_archive: messageIds.length,
      method: "batch",
      summary,
      commit_command: `bun run scripts/gmail-commit.ts commit --run-id ${result.runId}`,
      cancel_command: `bun run scripts/gmail-commit.ts cancel --run-id ${result.runId}`,
    });
  } else {
    ok({
      archived: messageIds.length,
      method: "batch",
      run_id: result.runId,
      committed: result.committed,
      failed: result.failed,
    });
  }
}

/** Path 4: --message-id — single message archive (no confirmation). */
async function archiveSingleMessage(
  messageId: string,
  account?: string,
): Promise<void> {
  const resp = await gmailPost(
    `/messages/${messageId}/modify`,
    { removeLabelIds: ["INBOX"] },
    account,
  );

  if (!resp.ok) {
    printError(
      `Failed to archive message (status ${resp.status}): ${JSON.stringify(resp.data)}`,
    );
  }

  ok({ archived: 1, method: "single" });
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

/**
 * Resume an interrupted or partially-failed run.
 * Loads the op log, finds pending (staged but not committed/failed) ops,
 * and re-executes them.
 */
async function resumeRun(
  resumeRunId: string,
  account?: string,
): Promise<void> {
  if (!runExists(resumeRunId)) {
    printError(`Run not found: ${resumeRunId}`);
    return;
  }

  const pending = getPendingOps(resumeRunId);
  if (pending.length === 0) {
    const summary = summarizeRun(resumeRunId);
    ok({
      resumed: false,
      run_id: resumeRunId,
      note: "No pending operations to resume",
      summary,
    });
    return;
  }

  let committed = 0;
  let failed = 0;

  for (const entry of pending) {
    if (!entry.message_ids || entry.chunk_index === undefined) continue;

    try {
      const resp = await gmailPost(
        "/messages/batchModify",
        { ids: entry.message_ids, removeLabelIds: ["INBOX"] },
        account,
      );
      if (!resp.ok) {
        const errMsg = `batchModify failed (status ${resp.status}): ${JSON.stringify(resp.data)}`;
        writeFailed(resumeRunId, entry.chunk_index, errMsg);
        failed++;
        continue;
      }
      writeCommitted(resumeRunId, entry.chunk_index);
      committed++;
    } catch (err) {
      if (err instanceof DailyQuotaExceededError) {
        writeInterrupted({
          run_id: resumeRunId,
          reason: "daily_quota",
          resume_hint: "Resume after midnight PT",
        });
        throw err;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      writeFailed(resumeRunId, entry.chunk_index, errMsg);
      failed++;
    }
  }

  writeCompleted(resumeRunId, committed, failed);
  const summary = summarizeRun(resumeRunId);
  ok({
    resumed: true,
    run_id: resumeRunId,
    committed,
    failed,
    summary,
  });
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const account = optionalArg(args, "account");
  const skipConfirm = args["skip-confirm"] === true;
  const dryRun = args["dry-run"] === true;
  const runId = optionalArg(args, "run-id");
  const phase = optionalArg(args, "phase");

  // Resume mode
  const resumeRunId = optionalArg(args, "resume");
  if (resumeRunId) {
    await resumeRun(resumeRunId, account);
    return;
  }

  const query = optionalArg(args, "query");
  const cacheKey = optionalArg(args, "cache-key");
  const senderEmailsRaw = optionalArg(args, "sender-emails");
  const messageIdsRaw = optionalArg(args, "message-ids");
  const messageId = optionalArg(args, "message-id");

  // Priority: --query > --cache-key > --message-ids > --message-id
  if (query) {
    await archiveByQuery(query, account, skipConfirm, runId, phase, dryRun);
  } else if (cacheKey && senderEmailsRaw) {
    const senderEmails = parseCsv(senderEmailsRaw);
    await archiveByCacheKey(
      cacheKey,
      senderEmails,
      account,
      skipConfirm,
      runId,
      phase,
      dryRun,
    );
  } else if (messageIdsRaw) {
    const messageIds = parseCsv(messageIdsRaw);
    await archiveByMessageIds(messageIds, account, skipConfirm, runId, phase, dryRun);
  } else if (messageId) {
    await archiveSingleMessage(messageId, account);
  } else {
    printError(
      "Provide --query, --cache-key + --sender-emails, --message-ids, --message-id, or --resume <run-id>.",
    );
  }
}

if (import.meta.main) {
  main().catch((err) => {
    if (err instanceof DailyQuotaExceededError) {
      // Already written to op log — surface a user-friendly message
      ok({
        interrupted: true,
        reason: "daily_quota",
        note: "Gmail daily quota exceeded. Resume after midnight PT with --resume <run-id>.",
      });
      return;
    }
    printError(err instanceof Error ? err.message : String(err));
  });
}
