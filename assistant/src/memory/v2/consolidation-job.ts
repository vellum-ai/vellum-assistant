/**
 * Memory v2 — `memory_v2_consolidate` job handler.
 *
 * The consolidation job is the centerpiece of v2: an hourly background pass
 * that routes accumulated `memory/buffer.md` entries into concept pages,
 * rewrites `memory/recent.md`, promotes new essentials/threads, and trims the
 * buffer down to entries that arrived after the run started.
 *
 * Consolidation runs as the assistant: `runBackgroundJob()` bootstraps a
 * background conversation and routes the cutoff-templated prompt through
 * `processMessage`, so the standard system prompt (SOUL.md + IDENTITY.md +
 * persona + memory/* autoloads) and tool surface (read_file, write_file,
 * edit_file, list_files, bash) are loaded. Care, judgment, and the
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
 *   5. Hand off to `runBackgroundJob()` with the templated prompt. The runner
 *      handles bootstrap + processMessage + timeout + error classification,
 *      and (because we set `suppressFailureNotifications: true`) does NOT
 *      emit an `activity.failed` notification on transient failures —
 *      consolidation runs on tight intervals, so a network blip or model
 *      hiccup should not spam the home feed. Sentry-side reporting is
 *      unchanged.
 *   6. On success, enqueue `memory_v2_rebuild_edges` (regenerate frontmatter
 *      from `edges.json`) and `memory_v2_reembed` (re-index any pages the
 *      agent touched). Tracking touched pages via mtime would be more precise
 *      but is fragile across filesystems; the embedder's content-hash cache
 *      makes a conservative full-reembed effectively free. On failure no
 *      follow-ups are enqueued — the agent's writes may be partial and
 *      re-embedding partial state would be misleading.
 *   7. Release the lock.
 *
 * The handler never propagates exceptions from the run path — `runBackgroundJob`
 * absorbs them and returns a structured result. A thrown error before the
 * runner is invoked (e.g. mkdir failures) bubbles up and the jobs-worker
 * treats it as a retryable failure.
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
import { runBackgroundJob } from "../../runtime/background-job-runner.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import {
  enqueueMemoryJob,
  type MemoryJob,
  type MemoryJobType,
} from "../jobs-store.js";
import { renderConsolidationPrompt } from "./prompts/consolidation.js";

const log = getLogger("memory-v2-consolidate");

/** Source string identifying this background conversation in logs and surfaces. */
const JOB_SOURCE = "memory";

/** Stable identifier surfaced in `runBackgroundJob` logs and notifications. */
const JOB_NAME = "memory.consolidate";

/**
 * Hard timeout for the consolidation run. Consolidation reads the buffer,
 * rewrites several files, and re-encodes essentials/threads — generous
 * upper bound so a slow run isn't killed mid-edit, but bounded so a stuck
 * provider can't pin the worker indefinitely.
 */
const CONSOLIDATION_TIMEOUT_MS = 15 * 60 * 1000;

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
 * invoked / failed) without having to spy on the filesystem.
 */
export type ConsolidationOutcome =
  | { kind: "flag_off" }
  | { kind: "locked"; holder: string }
  | { kind: "empty_buffer" }
  | { kind: "run_failed"; reason?: string }
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

    // Step 4: hand off to the centralized background-job runner. The runner
    // bootstraps the conversation, drives `processMessage`, applies the
    // timeout policy, classifies errors, and — because we opt out via
    // `suppressFailureNotifications` — does NOT emit an `activity.failed`
    // notification on transient failures. Consolidation runs on tight
    // intervals; a network blip or model hiccup should not spam the feed.
    // Sentry-side reporting is unchanged.
    const runResult = await runBackgroundJob({
      jobName: JOB_NAME,
      source: JOB_SOURCE,
      prompt: renderConsolidationPrompt(cutoff),
      trustContext: { sourceChannel: "vellum", trustClass: "guardian" },
      callSite: "mainAgent",
      timeoutMs: CONSOLIDATION_TIMEOUT_MS,
      origin: "memory_consolidation",
      suppressFailureNotifications: true,
    });

    if (!runResult.ok) {
      log.error(
        {
          conversationId: runResult.conversationId,
          errorKind: runResult.errorKind,
          err: runResult.error?.message,
        },
        "consolidation run failed; follow-ups skipped",
      );
      return runResult.error?.message !== undefined
        ? { kind: "run_failed", reason: runResult.error.message }
        : { kind: "run_failed" };
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
        conversationId: runResult.conversationId,
        cutoff,
        followUpJobIds,
      },
      "consolidation invoked",
    );
    return {
      kind: "invoked",
      conversationId: runResult.conversationId,
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
 * crash in the run path doesn't leave the lock stranded. ENOENT is swallowed
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
