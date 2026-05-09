/**
 * Memory v2 — `memory_v2_consolidate` job handler.
 *
 * The consolidation job is the centerpiece of v2: an hourly background pass
 * that routes accumulated `memory/buffer.md` entries into concept pages,
 * rewrites `memory/recent.md`, promotes new essentials/threads, and trims the
 * buffer down to entries that arrived after the run started.
 *
 * Unlike `sweep`, consolidation runs as the assistant: `wakeAgentForOpportunity()`
 * loads the standard system prompt (SOUL.md + IDENTITY.md + persona + memory/*
 * autoloads) and the standard tool surface (read_file, write_file, edit_file,
 * list_files, bash). The hint string carries the prompt body from §10 of the
 * design doc with the cutoff timestamp templated in. Care, judgment, and the
 * assistant's voice are the point — there is no "consolidator persona" to
 * substitute in.
 *
 * Lifecycle:
 *   1. Bail if `config.memory.v2.enabled` is false (the worker may have
 *      claimed a stale row from before v2 was disabled).
 *   2. Acquire a single-process lock at `memory/.v2-state/consolidation.lock`
 *      so two overlapping schedule windows can't fight over the same files.
 *      The lock contains the holder's PID + timestamp so a crashed run leaves
 *      a diagnosable trace.
 *   3. Capture the cutoff timestamp at dispatch. Any buffer entry timestamped
 *      at or after the cutoff arrived AFTER the run started — leave it for
 *      the next pass.
 *   4. Read `memory/buffer.md`. Bail if empty (no work to do, but the lock
 *      and skip path still log so operators can confirm the schedule fired).
 *   5. Bootstrap a background conversation (mirrors `runUpdateBulletinJobIfNeeded`)
 *      and call `wakeAgentForOpportunity()` with the templated hint. The wake
 *      reuses the assistant's full system prompt + tools.
 *   6. On wake success, enqueue `memory_v2_reembed` to re-index any pages the
 *      agent touched. Tracking touched pages via mtime would be more precise
 *      but is fragile across filesystems; the embedder's content-hash cache
 *      makes a conservative full-reembed effectively free. On wake failure
 *      no follow-ups are enqueued — the agent didn't run, so there's nothing
 *      to re-embed.
 *   7. Release the lock.
 *
 * The handler never propagates a wake exception: it logs, cleans up the
 * orphan conversation, releases the lock, and returns `wake_failed` so the
 * next scheduled run can re-attempt. A thrown bootstrap error bubbles up and
 * the jobs-worker treats it as a retryable failure.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { AssistantConfig } from "../../config/types.js";
import { INTERNAL_GUARDIAN_TRUST_CONTEXT } from "../../daemon/trust-context.js";
import { wakeAgentForOpportunity } from "../../runtime/agent-wake.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { isProcessAlive } from "../../util/process-liveness.js";
import { bootstrapConversation } from "../conversation-bootstrap.js";
import { deleteConversation } from "../conversation-crud.js";
import { formatBufferTimestamp } from "../graph/tool-handlers.js";
import {
  enqueueMemoryJob,
  type MemoryJob,
  type MemoryJobType,
} from "../jobs-store.js";
import { MEMORY_V2_CONSOLIDATION_SOURCE } from "./constants.js";
import { resolveConsolidationPrompt } from "./prompts/consolidation.js";

const log = getLogger("memory-v2-consolidate");

/**
 * Follow-up jobs to fan out after a successful consolidation.
 *
 * Conservatively re-embeds every page rather than tracking which pages the
 * agent touched: mtime-diffing is fragile across filesystems, and the
 * embedder's content-hash cache makes unchanged pages effectively free.
 */
const FOLLOW_UP_JOB_TYPES: readonly MemoryJobType[] = [
  "memory_v2_reembed",
] as const;

/**
 * Job handler. See file header for the full lifecycle. Returns a discriminated
 * union so tests can assert on the path taken (disabled / locked / empty /
 * invoked) without having to spy on the filesystem.
 */
export type ConsolidationOutcome =
  | { kind: "disabled" }
  | { kind: "locked"; holder: string }
  | { kind: "empty_buffer" }
  | { kind: "wake_failed"; reason?: string }
  | {
      kind: "invoked";
      conversationId: string;
      cutoff: string;
      followUpJobIds: string[];
    };

export async function memoryV2ConsolidateJob(
  _job: MemoryJob,
  config: AssistantConfig,
): Promise<ConsolidationOutcome> {
  if (!config.memory.v2.enabled) {
    log.debug("memory.v2.enabled is false; consolidation skipped");
    return { kind: "disabled" };
  }

  const memoryDir = join(getWorkspaceDir(), "memory");
  const lockPath = join(memoryDir, ".v2-state", "consolidation.lock");
  const bufferPath = join(memoryDir, "buffer.md");

  // Step 1: acquire lock. Bails immediately if another consolidation is
  // already in flight — the next scheduled run can pick up where we leave off.
  const holder = tryAcquireLock(lockPath);
  if (holder !== null) {
    log.warn({ lockPath, holder }, "consolidation skipped: lock already held");
    return { kind: "locked", holder };
  }

  try {
    // Step 2: capture cutoff. Formatted to match `buffer.md` entry timestamps
    // (`Mon D, h:mm AM/PM`, see `formatBufferTimestamp`) so the agent's
    // "timestamp ≥ cutoff" check compares like-with-like at minute precision.
    // Same-minute entries land on the next pass — conservative but loss-free.
    // Captured here (not at enqueue time) so late-claimed rows get a fresh
    // cutoff.
    const cutoff = formatBufferTimestamp(new Date());

    // Step 3: bail on empty buffer. Nothing for the agent to consolidate.
    // The lock is released in finally below.
    const bufferContent = readBufferContent(bufferPath);
    if (bufferContent.trim().length === 0) {
      log.debug("buffer.md empty; consolidation skipped");
      return { kind: "empty_buffer" };
    }

    // Step 4: bootstrap a background conversation and wake the assistant
    // with the cutoff-templated prompt. Mirrors the UPDATES.md pattern in
    // `runUpdateBulletinJobIfNeeded` — the wake runs `mainAgent` against
    // the assistant's full system prompt, so consolidation thinks and
    // writes in the assistant's voice.
    const conversation = bootstrapConversation({
      conversationType: "background",
      source: MEMORY_V2_CONSOLIDATION_SOURCE,
      origin: "memory_consolidation",
      systemHint: "Running memory consolidation",
      groupId: "system:background",
    });

    let wakeInvoked = false;
    let failureReason: string | undefined;
    try {
      const result = await wakeAgentForOpportunity({
        conversationId: conversation.id,
        hint: resolveConsolidationPrompt(
          config.memory.v2.consolidation_prompt_path,
          cutoff,
        ),
        source: MEMORY_V2_CONSOLIDATION_SOURCE,
        trustContext: INTERNAL_GUARDIAN_TRUST_CONTEXT,
      });
      wakeInvoked = result.invoked;
      failureReason = result.reason;
    } catch (err) {
      failureReason = err instanceof Error ? err.message : String(err);
      log.error(
        { err, conversationId: conversation.id },
        "consolidation wake threw; cleaning up and re-enqueuing follow-ups skipped",
      );
    }

    // If the wake never ran (resolver missing, conversation archived,
    // timeout, exception), clean up the orphan background conversation —
    // matches the cleanup logic in `runUpdateBulletinJobIfNeeded`. We
    // do NOT enqueue follow-ups in this branch because no pages changed.
    if (!wakeInvoked) {
      try {
        deleteConversation(conversation.id);
      } catch (err) {
        log.warn(
          { err, conversationId: conversation.id },
          "consolidation: failed to delete orphan background conversation; continuing",
        );
      }
      return failureReason !== undefined
        ? { kind: "wake_failed", reason: failureReason }
        : { kind: "wake_failed" };
    }

    // Step 5: enqueue follow-up jobs. Enqueueing now keeps the dispatch
    // wiring exercised end-to-end so PR 21 only has to swap in the handler
    // bodies.
    const followUpJobIds: string[] = [];
    for (const jobType of FOLLOW_UP_JOB_TYPES) {
      try {
        followUpJobIds.push(enqueueMemoryJob(jobType, {}));
      } catch (err) {
        // Best-effort: a failed enqueue here doesn't undo the agent's writes,
        // and the next scheduled consolidation will attempt the same fan-out.
        log.warn(
          { err, jobType },
          "consolidation: failed to enqueue follow-up job; continuing",
        );
      }
    }

    log.info(
      {
        conversationId: conversation.id,
        cutoff,
        followUpJobIds,
      },
      "consolidation invoked",
    );
    return {
      kind: "invoked",
      conversationId: conversation.id,
      cutoff,
      followUpJobIds,
    };
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Read `memory/buffer.md`. Missing file → empty string so the skip-on-empty
 * branch doesn't have to distinguish "no file" from "blank file".
 */
function readBufferContent(bufferPath: string): string {
  try {
    return readFileSync(bufferPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Atomically create the lock file with `wx` (O_CREAT | O_EXCL) flags. Returns
 * `null` on success, or the current holder string (file contents, typically
 * `pid timestamp`) when the file already exists and the holder is still alive.
 *
 * Stale-lock takeover: if the file exists but its holder PID is not running,
 * unlink the stale file and retry the create exactly once. This recovers
 * automatically from a crashed daemon that died with the lock held —
 * otherwise every subsequent scheduled consolidation would skip with `locked`
 * indefinitely until an operator manually removed the file.
 *
 * The simple takeover-then-retry is safe here (unlike `snapshot-lock.ts`'s
 * full rename-aside dance) because only the assistant's jobs worker calls
 * this lock, and at most one assistant process runs per workspace at any
 * time. A holder with an unparseable / empty payload is treated as stale —
 * the only writers ever produce a `<pid> <timestamp>` line, so an
 * unparseable file is corruption from a partial write that crashed.
 */
function tryAcquireLock(lockPath: string): string | null {
  // The workspace migration seeds `memory/.v2-state/`, but tests and
  // ad-hoc workspaces may not have it yet. `mkdirSync({ recursive: true })`
  // is idempotent, so the call is cheap when the dir already exists.
  mkdirSync(dirname(lockPath), { recursive: true });

  const firstHolder = tryCreate(lockPath);
  if (firstHolder === null) return null;
  if (!isHolderStale(firstHolder)) return firstHolder;

  log.info(
    { lockPath, holder: firstHolder },
    "consolidation: taking over stale lock (holder not running)",
  );
  try {
    unlinkSync(lockPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      log.warn(
        { err, lockPath },
        "consolidation: failed to unlink stale lock; reporting as locked",
      );
      return firstHolder;
    }
  }
  // After unlink, the next `wx` create should succeed. If a third party
  // raced in and re-acquired (vanishingly unlikely with one writer per
  // workspace), surface their holder string rather than overwriting.
  return tryCreate(lockPath);
}

/**
 * Atomically create the lock file. Returns `null` on success, or the holder
 * string read from the file when it already exists (`"unknown"` if the read
 * itself fails). Rethrows any non-EEXIST errno from `openSync`.
 */
function tryCreate(lockPath: string): string | null {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    try {
      return readFileSync(lockPath, "utf-8").trim() || "unknown";
    } catch {
      return "unknown";
    }
  }
  try {
    writeSync(fd, `${process.pid} ${Date.now()}\n`);
  } catch {
    // best-effort — payload is advisory, the file's existence is the lock
  } finally {
    try {
      closeSync(fd);
    } catch {
      // best-effort
    }
  }
  return null;
}

/**
 * A holder string is stale when its PID parses to a non-running process.
 * The payload format is `<pid> <timestamp>` (see `tryCreate`'s write), but
 * an unparseable / empty / `"unknown"` payload is also treated as stale:
 * the only writer is `tryCreate` itself, so corruption indicates a partial
 * write from a crashed prior holder rather than a live writer mid-flush.
 */
function isHolderStale(holder: string): boolean {
  const match = /^\d+/.exec(holder);
  if (!match) return true;
  const pid = Number.parseInt(match[0], 10);
  if (!Number.isFinite(pid) || pid <= 0) return true;
  return !isProcessAlive(pid);
}

/**
 * Idempotent unlink of the lock file. Called from the `finally` block so a
 * crash in the wake path doesn't leave the lock stranded. ENOENT is swallowed
 * because the lock may have been released by an operator or never created
 * (acquire failed before reaching the lock-write step).
 */
function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    log.warn(
      { err, lockPath },
      "consolidation: failed to release lock (best-effort)",
    );
  }
}
