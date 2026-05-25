/**
 * Memory v3 — `memory_v3_consolidate` job handler.
 *
 * The v3 consolidation job drains the SHARED `memory/buffer.md` (the same
 * buffer v2 uses — there is no v3 buffer) into the SHARED concept pages AND the
 * v3 **tree** overlay, while maintaining the SHARED standing-context files
 * (`essentials.md` / `threads.md` / `recent.md`) byte-for-byte the way v2 does.
 * It is the v3 counterpart to `assistant/src/memory/v2/consolidation-job.ts`
 * and mirrors its orchestration exactly — the only divergences are the gating
 * flag (`memory.v3.write.enabled`), the lock path (`memory/.v3-state/`), and the
 * prompt body (which additionally asks the agent to author/refresh the tree).
 *
 * Because the buffer and the standing-context files are shared, exactly one
 * consolidator may own the drain at a time. The scheduler enforces this: when
 * `memory.v3.write.enabled` is on it enqueues `memory_v3_consolidate` INSTEAD of
 * `memory_v2_consolidate` (see `maybeEnqueueGraphMaintenanceJobs` in
 * `jobs-worker.ts`). Concept pages stay the shared canonical store, so the v2
 * router keeps working off pages v3 writes — it just ignores the tree overlay.
 *
 * Lifecycle (identical to v2 except the flag + lock path + tree-authoring
 * prompt):
 *   1. Bail if `config.memory.v3.write.enabled` is false (the worker may have
 *      claimed a stale row from before the flag was flipped off).
 *   2. Acquire a single-process lock at `memory/.v3-state/consolidation.lock`.
 *   3. Capture the cutoff timestamp at dispatch.
 *   4. Read the shared `memory/buffer.md`. Bail if empty.
 *   5. Hand off to `runBackgroundJob()` with the v3 consolidation prompt
 *      (`suppressFailureNotifications: true`).
 *   6. On success, enqueue follow-ups: `memory_v3_index_maintenance` (mechanical
 *      tree/DAG upkeep) and `embed_concept_page` reembed (pages are shared, so
 *      reembed is still needed — reuse the existing `memory_v2_reembed` fan-out
 *      job type, which enqueues one `embed_concept_page` per slug).
 *   7. Release the lock.
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
import { runBackgroundJob } from "../../runtime/background-job-runner.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { isProcessAlive } from "../../util/process-liveness.js";
import { formatBufferTimestamp } from "../graph/tool-handlers.js";
import {
  enqueueMemoryJob,
  type MemoryJob,
  type MemoryJobType,
} from "../jobs-store.js";
// The consolidation conversation `source` is a UI/routing concern shared with
// v2 (the route layer recognizes "this conversation IS background memory
// consolidation" by this string). v2 and v3 are mutually exclusive drainers, so
// reusing the same source keeps that recognition working for both without
// forking a v3 constant.
import { MEMORY_V2_CONSOLIDATION_SOURCE } from "../v2/constants.js";
import { resolveConsolidationPrompt } from "./prompts/consolidation.js";

const log = getLogger("memory-v3-consolidate");

/** Stable identifier surfaced in `runBackgroundJob` logs and notifications. */
const JOB_NAME = "memory.consolidate";

/**
 * Hard timeout for the consolidation run. Matches v2: consolidation reads the
 * buffer, rewrites several files, re-encodes essentials/threads, and authors
 * the tree — generous upper bound so a slow run isn't killed mid-edit, but
 * bounded so a stuck provider can't pin the worker indefinitely.
 */
const CONSOLIDATION_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Follow-up jobs to fan out after a successful consolidation:
 *   - `memory_v3_index_maintenance` — mechanical (no-LLM) tree/DAG upkeep:
 *     validate the tree, report stale composed indices, cycle-check the DAG.
 *   - `memory_v2_reembed` — re-embed every shared concept page (the fan-out job
 *     enqueues one `embed_concept_page` per slug). Pages are shared, so a v3
 *     consolidation that touches them still needs the reembed. Conservatively
 *     re-embeds every page; the embedder's content-hash cache makes unchanged
 *     pages effectively free.
 */
const FOLLOW_UP_JOB_TYPES: readonly MemoryJobType[] = [
  "memory_v3_index_maintenance",
  "memory_v2_reembed",
] as const;

/**
 * Job handler. See file header for the full lifecycle. Returns a discriminated
 * union so tests can assert on the path taken (disabled / locked / empty /
 * invoked / failed) without having to spy on the filesystem. Mirrors v2's
 * `ConsolidationOutcome`.
 */
export type ConsolidationOutcome =
  | { kind: "disabled" }
  | { kind: "locked"; holder: string }
  | { kind: "empty_buffer" }
  | { kind: "run_failed"; reason?: string }
  | {
      kind: "invoked";
      conversationId: string;
      cutoff: string;
      followUpJobIds: string[];
    };

export async function memoryV3ConsolidateJob(
  _job: MemoryJob,
  config: AssistantConfig,
): Promise<ConsolidationOutcome> {
  if (!config.memory.v3.write.enabled) {
    log.debug("memory.v3.write.enabled is false; consolidation skipped");
    return { kind: "disabled" };
  }

  const memoryDir = join(getWorkspaceDir(), "memory");
  const lockPath = join(memoryDir, ".v3-state", "consolidation.lock");
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
    // (`Mon D, h:mm AM/PM`) so the agent's "timestamp ≥ cutoff" check compares
    // like-with-like at minute precision. Captured here (not at enqueue time)
    // so late-claimed rows get a fresh cutoff.
    const cutoff = formatBufferTimestamp(new Date());

    // Step 3: bail on empty buffer. The shared buffer has no work to drain.
    const bufferContent = readBufferContent(bufferPath);
    if (bufferContent.trim().length === 0) {
      log.debug("buffer.md empty; consolidation skipped");
      return { kind: "empty_buffer" };
    }

    // Step 4: hand off to the centralized background-job runner. As with v2,
    // `suppressFailureNotifications: true` opts out of `activity.failed`
    // notifications so a network blip on the tight consolidation interval does
    // not spam the home feed; Sentry-side reporting is unchanged.
    //
    // The prompt override config key (`memory.v2.consolidation_prompt_path`) is
    // shared — there is no separate v3 key, so an operator points one file at
    // whichever consolidator owns the drain.
    const runResult = await runBackgroundJob({
      jobName: JOB_NAME,
      source: MEMORY_V2_CONSOLIDATION_SOURCE,
      prompt: resolveConsolidationPrompt(
        config.memory.v2.consolidation_prompt_path,
        cutoff,
      ),
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

    // Step 5: enqueue follow-up jobs (tree maintenance + page reembed).
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
 * `null` on success, or the current holder string when the file already exists
 * and the holder is still alive. Mirrors v2's lock machinery exactly — single
 * writer per workspace, so a holder whose process died is unambiguously stale
 * and is taken over automatically.
 */
function tryAcquireLock(lockPath: string): string | null {
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
 * A holder string is stale when its PID parses to a non-running process. An
 * unparseable / empty / `"unknown"` payload is also treated as stale: the only
 * writer is `tryCreate`, so corruption indicates a partial write from a crashed
 * prior holder rather than a live writer mid-flush.
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
 * crash in the run path doesn't leave the lock stranded. ENOENT is swallowed
 * because the lock may have been released by an operator or never created.
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
