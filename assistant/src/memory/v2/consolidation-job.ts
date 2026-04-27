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
 *   1. Bail if the `memory-v2-enabled` feature flag is off (the worker may
 *      have claimed a stale row at flag-flip time).
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
 *   6. On wake success, enqueue `memory_v2_rebuild_edges` (regenerate
 *      frontmatter from `edges.json`) and `memory_v2_reembed` (re-index any
 *      pages the agent touched). Tracking touched pages via mtime would be
 *      more precise but is fragile across filesystems; the embedder's
 *      content-hash cache makes a conservative full-reembed effectively free.
 *      On wake failure no follow-ups are enqueued — the agent didn't run, so
 *      there's nothing to regenerate or re-embed.
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

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../../config/types.js";
import { wakeAgentForOpportunity } from "../../runtime/agent-wake.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { bootstrapConversation } from "../conversation-bootstrap.js";
import { deleteConversation } from "../conversation-crud.js";
import {
  enqueueMemoryJob,
  type MemoryJob,
  type MemoryJobType,
} from "../jobs-store.js";
import { renderConsolidationPrompt } from "./prompts/consolidation.js";

const log = getLogger("memory-v2-consolidate");

/** Source string identifying this wake in `agent-wake` logs and surfaces. */
const WAKE_SOURCE = "memory_v2_consolidation";

/**
 * Follow-up jobs to fan out after a successful consolidation. Both are stubs
 * from PR 6 today; PR 21 will replace them with real handlers.
 *
 * Conservatively re-embeds every page rather than tracking which pages the
 * agent touched: mtime-diffing is fragile across filesystems, and the
 * embedder's content-hash cache makes unchanged pages effectively free.
 */
const FOLLOW_UP_JOB_TYPES: readonly MemoryJobType[] = [
  "memory_v2_rebuild_edges",
  "memory_v2_reembed",
] as const;

/**
 * Job handler. See file header for the full lifecycle. Returns a discriminated
 * union so tests can assert on the path taken (flag-off / locked / empty /
 * invoked) without having to spy on the filesystem.
 */
export type ConsolidationOutcome =
  | { kind: "flag_off" }
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
  if (!isAssistantFeatureFlagEnabled("memory-v2-enabled", config)) {
    log.debug("memory-v2-enabled flag off; consolidation skipped");
    return { kind: "flag_off" };
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
    // Step 2: capture cutoff. ISO-8601 is the convention; it's a total order
    // string that compares correctly via lexicographic <, which is all the
    // prompt asks the agent to do. Captured here (not at enqueue time) so
    // late-claimed rows still get a fresh cutoff.
    const cutoff = new Date().toISOString();

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
      source: WAKE_SOURCE,
      origin: "memory_consolidation",
      systemHint: "Running memory consolidation",
      groupId: "system:background",
    });

    let wakeInvoked = false;
    let failureReason: string | undefined;
    try {
      const result = await wakeAgentForOpportunity({
        conversationId: conversation.id,
        hint: renderConsolidationPrompt(cutoff),
        source: WAKE_SOURCE,
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
 * `pid timestamp`) when the file already exists — the holder is surfaced for
 * log diagnostics so operators can identify a stuck lock without re-reading.
 *
 * Crash recovery: if the prior daemon died with the lock held, the file will
 * still be on disk on the next start. PR 20 keeps the lock simple per the
 * plan instructions; a future iteration can probe liveness via `kill(pid, 0)`
 * the way `snapshot-lock.ts` does. Until then, an operator can clear a
 * stale lock by removing the file.
 */
function tryAcquireLock(lockPath: string): string | null {
  // The workspace migration seeds `memory/.v2-state/`, but tests and
  // ad-hoc workspaces may not have it yet. `mkdirSync({ recursive: true })`
  // is idempotent, so the call is cheap when the dir already exists.
  mkdirSync(dirname(lockPath), { recursive: true });

  let fd: number;
  try {
    // `wx` = create-if-not-exists, fail with EEXIST if it does.
    fd = openSync(lockPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    try {
      return readFileSync(lockPath, "utf-8").trim() || "unknown";
    } catch {
      return "unknown";
    }
  }

  // Best-effort PID + timestamp payload so a stale lock can be diagnosed.
  // The worker only cares that the file exists; the contents are advisory.
  try {
    writeSync(fd, `${process.pid} ${Date.now()}\n`);
  } catch {
    // best-effort
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
