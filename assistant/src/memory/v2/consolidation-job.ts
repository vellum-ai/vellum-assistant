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
 *   5. Hand off to `runBackgroundJob()` with the templated prompt. The runner
 *      handles bootstrap + processMessage + timeout + error classification,
 *      and (because we set `suppressFailureNotifications: true`) does NOT
 *      emit an `activity.failed` notification on transient failures —
 *      consolidation runs on tight intervals, so a network blip or model
 *      hiccup should not spam the home feed. Sentry-side reporting is
 *      unchanged. The prompt body is loaded via `resolveConsolidationPrompt`
 *      which bounds any operator-provided override to a regular file under
 *      1 MiB before substitution.
 *   6. On success, enqueue `memory_v2_reembed` (re-index any pages the agent
 *      touched). Tracking touched pages via mtime would be more precise but
 *      is fragile across filesystems; the embedder's content-hash cache makes
 *      a conservative full-reembed effectively free. On failure no follow-ups
 *      are enqueued — the agent's writes may be partial and re-embedding
 *      partial state would be misleading.
 *   7. Release the lock. If a prior holder's PID is no longer running, the
 *      stale lock is taken over automatically (single-writer per workspace,
 *      so a holder whose process died is unambiguously stale).
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
import { isProcessAlive } from "../../util/process-liveness.js";
import { formatBufferTimestamp } from "../graph/tool-handlers.js";
import {
  enqueueMemoryJob,
  type MemoryJob,
  type MemoryJobType,
} from "../jobs-store.js";
import { MEMORY_V2_CONSOLIDATION_SOURCE } from "./constants.js";
import { resolveConsolidationPrompt } from "./prompts/consolidation.js";

const log = getLogger("memory-v2-consolidate");

/** Stable identifier surfaced in `runBackgroundJob` logs and notifications. */
const JOB_NAME = "memory.consolidate";

/**
 * v3 plugin flags. Either being on enqueues `memory_v3_maintain` as a
 * post-consolidation follow-up. These gate the v3 plugin itself.
 */
const MEMORY_V3_SHADOW = "memory-v3-shadow" as const;
const MEMORY_V3_LIVE = "memory-v3-live" as const;

/**
 * Hard timeout for the consolidation run. Consolidation reads the buffer,
 * rewrites several files, and re-encodes essentials/threads — generous
 * upper bound so a slow run isn't killed mid-edit, but bounded so a stuck
 * provider can't pin the worker indefinitely.
 */
const CONSOLIDATION_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Follow-up jobs to fan out after a successful consolidation.
 *
 * Conservatively re-embeds every page rather than tracking which pages the
 * agent touched: mtime-diffing is fragile across filesystems, and the
 * embedder's content-hash cache makes unchanged pages effectively free.
 */
const FOLLOW_UP_JOB_TYPES: readonly MemoryJobType[] = ["memory_v2_reembed"];

/** Follow-up enqueued only when a v3 flag is on. */
const V3_FOLLOW_UP_JOB_TYPE: MemoryJobType = "memory_v3_maintain";

/**
 * Job handler. See file header for the full lifecycle. Returns a discriminated
 * union so tests can assert on the path taken (disabled / locked / empty /
 * invoked / failed) without having to spy on the filesystem.
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

    // Step 4: hand off to the centralized background-job runner. The runner
    // bootstraps the conversation, drives `processMessage`, applies the
    // timeout policy, classifies errors, and — because we opt out via
    // `suppressFailureNotifications` — does NOT emit an `activity.failed`
    // notification on transient failures. Consolidation runs on tight
    // intervals; a network blip or model hiccup should not spam the feed.
    // Sentry-side reporting is unchanged.
    //
    // The prompt body comes from `resolveConsolidationPrompt`, which honors
    // the `memory.v2.consolidation_prompt_path` config override but bounds
    // it to a regular file under 1 MiB before substitution so a stray path
    // (or a `/dev/zero`-style pseudo-file) cannot exfiltrate megabytes of
    // bytes through the wake hint. The core-pages curation section rides the
    // same v3 gate as the maintenance follow-up: the file feeds the v3 core
    // lane, so on a v2-only install the instruction would curate a file
    // nothing reads.
    const memoryV3Active =
      isAssistantFeatureFlagEnabled(MEMORY_V3_SHADOW, config) ||
      isAssistantFeatureFlagEnabled(MEMORY_V3_LIVE, config);
    const prompt = resolveConsolidationPrompt(
      config.memory.v2.consolidation_prompt_path,
      cutoff,
      { includeCorePagesSection: memoryV3Active },
    );

    const runResult = await runBackgroundJob({
      jobName: JOB_NAME,
      source: MEMORY_V2_CONSOLIDATION_SOURCE,
      prompt,
      trustContext: { sourceChannel: "vellum", trustClass: "guardian" },
      callSite: "memoryV2Consolidation",
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
    // bodies. v3 maintenance is appended only while a v3 path (shadow or live)
    // is active, so it never fans out on v2-only installs.
    const followUpJobIds: string[] = [];
    const jobTypes: MemoryJobType[] = [...FOLLOW_UP_JOB_TYPES];
    if (memoryV3Active) {
      jobTypes.push(V3_FOLLOW_UP_JOB_TYPE);
    }
    for (const jobType of jobTypes) {
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
 * Count non-empty lines in `memory/buffer.md`. Used by the scheduler to
 * implement the size-based consolidation trigger. Missing file → 0.
 *
 * Each entry is one line (`- [Mon D, h:mm AM/PM] …\n`), so non-empty-line
 * count == entry count for a well-formed buffer; blank lines and trailing
 * newlines don't inflate the count.
 */
export function countBufferLines(bufferPath: string): number {
  const content = readBufferContent(bufferPath);
  if (content.length === 0) return 0;
  return content.split("\n").filter((line) => line.trim().length > 0).length;
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
