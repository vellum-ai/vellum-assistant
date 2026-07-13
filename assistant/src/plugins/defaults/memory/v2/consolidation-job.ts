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
 * persona + memory/* autoloads) is loaded. Care, judgment, and the
 * assistant's voice are the point — there is no "consolidator persona" to
 * substitute in.
 *
 * The tool surface is wire-scoped to {@link CONSOLIDATION_ALLOWED_TOOLS} — the
 * local memory-file operations this pass needs. See that constant for why the
 * run must not carry network egress or host-proxy tools.
 *
 * Lifecycle:
 *   1. Bail if `config.memory.enabled` or `config.memory.v2.enabled` is false
 *      (the worker may have claimed a stale row from before memory was
 *      disabled).
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
 *   6. Verify the run drained the buffer. `runResult.ok` only means the
 *      background run completed — the trim itself is delegated to the agent.
 *      A run that completes without shrinking the buffer is reported as
 *      `invoked` with `noProgress: true` and enqueues no follow-ups.
 *   7. On progress, enqueue `memory_v2_reembed` (re-index any pages the agent
 *      touched). Tracking touched pages via mtime would be more precise but
 *      is fragile across filesystems; the embedder's content-hash cache makes
 *      a conservative full-reembed effectively free. Each follow-up coalesces
 *      with an already-pending job of the same type. On failure no follow-ups
 *      are enqueued — the agent's writes may be partial and re-embedding
 *      partial state would be misleading.
 *   8. Release the lock. A stale lock is taken over automatically on the next
 *      run (single-writer per workspace): when the holder's PID is no longer
 *      running, or — because the daemon runs as PID 1 in containers and a
 *      restarted daemon collides with the dead holder's PID — when the lock is
 *      older than a TTL well above the run's hard timeout.
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

import { isMemoryV3Live } from "../../../../config/memory-v3-gate.js";
import type { AssistantConfig } from "../../../../config/types.js";
import {
  enqueueMemoryJob,
  hasPendingJobOfType,
  type MemoryJob,
  type MemoryJobType,
} from "../../../../persistence/jobs-store.js";
import { runBackgroundJob } from "../../../../runtime/background-job-runner.js";
import { formatBufferTimestamp } from "../graph/tool-handlers.js";
import { isProcessAlive } from "../host-utils.js";
import { getLogger } from "../logging.js";
import { getWorkspaceDir } from "../paths.js";
import { MEMORY_V2_CONSOLIDATION_SOURCE } from "./constants.js";
import { resolveConsolidationPrompt } from "./prompts/consolidation.js";

const log = getLogger("memory-v2-consolidate");

/** Stable identifier surfaced in `runBackgroundJob` logs and notifications. */
const JOB_NAME = "memory.consolidate";

/**
 * Tool surface the consolidation run is wire-scoped to. Consolidation is a
 * purely LOCAL memory-file reorganization pass: it reads `buffer.md` + existing
 * pages, writes/edits concept pages, rewrites recent/essentials/threads, and
 * trims the buffer. It has NO legitimate need for network egress or host-proxy
 * tools.
 *
 * Scoping is load-bearing because the run is guardian-trust + non-interactive:
 * the permission checker auto-approves any tool whose classified risk is within
 * the background threshold (default `low`), and a public `web_fetch` classifies
 * Low. An unrestricted surface would therefore let prompt injection embedded in
 * buffer/page content — which can originate from untrusted material the
 * assistant ingested (fetched web pages, emails, documents, channel messages) —
 * exfiltrate memory over an auto-approved egress channel. Wire-gating to this
 * allowlist removes that channel entirely: the excluded tools (`web_fetch`,
 * `web_search`, `network_request`, `host_*`, …) are never even presented to
 * the model, so the fix does not rely on the permission threshold. Mirrors the
 * hardening the sibling memory-retrospective job already applies.
 *
 * `bash` is included because page deletes/renames go through the shell (there
 * is no dedicated file-delete tool) and corpus operations need it; its
 * dangerous / networked invocations remain risk-classified and denied in this
 * background context regardless.
 */
const CONSOLIDATION_ALLOWED_TOOLS: readonly string[] = [
  "file_read",
  "file_write",
  "file_edit",
  "file_list",
  "code_search",
  "bash",
  "recall",
];

/**
 * Hard timeout for the consolidation run. Consolidation reads the buffer,
 * rewrites several files, and re-encodes essentials/threads — generous
 * upper bound so a slow run isn't killed mid-edit, but bounded so a stuck
 * provider can't pin the worker indefinitely.
 */
const CONSOLIDATION_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Age past which a lock held by an apparently-live PID is taken over anyway.
 *
 * The PID-liveness probe alone is not sufficient in containers: the daemon
 * runs as PID 1, so after a container restart `isProcessAlive(1)` reports the
 * NEW daemon as alive even though it is not the process that wrote the lock.
 * PID-1 collision means a lock left behind by a crashed/restarted run can
 * never be declared stale by liveness alone, and consolidation wedges
 * permanently (every scheduled run skips with `locked`).
 *
 * A lock older than this TTL is treated as abandoned regardless of PID
 * liveness. The bound is a large multiple of the run's hard timeout — the
 * lock timestamp is written at acquire time and a run can hold the lock for
 * at most `CONSOLIDATION_TIMEOUT_MS`, so a TTL well above that can never fire
 * against a legitimately in-flight run while still recovering a wedged lock
 * within a couple of scheduled passes.
 */
const STALE_LOCK_TTL_MS = 4 * CONSOLIDATION_TIMEOUT_MS;

/**
 * Follow-up jobs to fan out after a successful consolidation.
 *
 * Conservatively re-embeds every page rather than tracking which pages the
 * agent touched: mtime-diffing is fragile across filesystems, and the
 * embedder's content-hash cache makes unchanged pages effectively free.
 */
const FOLLOW_UP_JOB_TYPES: readonly MemoryJobType[] = ["memory_v2_reembed"];

/** Follow-up enqueued only when v3 is live. */
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
      /**
       * Buffer entries beyond `consolidation_max_entries_per_run` left for a
       * follow-up pass via the pulled-back cutoff. `0` when the whole buffer
       * fit in one run.
       */
      deferredEntries: number;
      followUpJobIds: string[];
      /**
       * `true` when the run completed without shrinking the buffer — the
       * agent never trimmed it, so nothing changed worth re-embedding and no
       * follow-ups were enqueued.
       */
      noProgress: boolean;
    };

export async function memoryV2ConsolidateJob(
  _job: MemoryJob,
  config: AssistantConfig,
): Promise<ConsolidationOutcome> {
  if (config.memory.enabled === false) {
    log.debug("memory.enabled is false; consolidation skipped");
    return { kind: "disabled" };
  }

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
    // Step 2: bail on empty buffer. Nothing for the agent to consolidate.
    // The lock is released in finally below.
    const bufferContent = readBufferContent(bufferPath);
    if (bufferContent.trim().length === 0) {
      log.debug("buffer.md empty; consolidation skipped");
      return { kind: "empty_buffer" };
    }

    // Baseline for the post-run progress check — same metric the scheduler's
    // size trigger uses, so "no progress" below means exactly "the trigger
    // condition still holds".
    const bufferLinesBefore = countNonEmptyLines(bufferContent);

    // Step 3: capture cutoff. Formatted to match `buffer.md` entry timestamps
    // (`Mon D, h:mm AM/PM`, see `formatBufferTimestamp`) so the agent's
    // "timestamp ≥ cutoff" check compares like-with-like at minute precision.
    // Same-minute entries land on the next pass — conservative but loss-free.
    // Captured here (not at enqueue time) so late-claimed rows get a fresh
    // cutoff.
    //
    // Chunking: when the buffer holds more than
    // `consolidation_max_entries_per_run` entries (a backlog from missed or
    // failed runs), pull the cutoff back to the first over-cap entry's
    // timestamp. The agent's existing "≥ cutoff stays" rule then defers the
    // overflow loss-free, and the `consolidation_max_buffer_lines` size
    // trigger re-fires while the remainder stays over threshold — so one run
    // never has to read an unbounded backlog into context. Entries sharing
    // the over-cap entry's minute are also deferred (conservative).
    //
    // Entries are counted by their timestamped bullet-start lines
    // (`- [Mon D, h:mm AM/PM] …`) rather than raw non-empty lines: a
    // remembered fact can carry embedded newlines, and its continuation
    // lines belong to the preceding entry, not the count.
    let cutoff = formatBufferTimestamp(new Date());
    let deferredEntries = 0;
    const maxEntries = config.memory.v2.consolidation_max_entries_per_run;
    if (maxEntries != null) {
      const entryTimestamps = bufferContent
        .split("\n")
        .map(extractBufferEntryTimestamp)
        .filter((timestamp): timestamp is string => timestamp !== null);
      if (entryTimestamps.length > maxEntries) {
        const overflowTimestamp = entryTimestamps[maxEntries];
        // Same-minute burst guard: timestamps have minute precision, so when
        // even the FIRST entry shares the over-cap entry's timestamp, a
        // pulled-back cutoff would tell the agent to defer every entry
        // ("timestamp ≥ cutoff stays") — zero progress, and the size trigger
        // would requeue the identical run forever. Fall back to the
        // full-buffer cutoff in that case; partial same-minute runs (some
        // earlier entries have older timestamps) still make progress.
        if (entryTimestamps[0] === overflowTimestamp) {
          log.warn(
            {
              bufferEntries: entryTimestamps.length,
              maxEntries,
              overflowTimestamp,
            },
            "consolidation: entire over-cap prefix shares one minute timestamp; processing full buffer to guarantee progress",
          );
        } else {
          cutoff = overflowTimestamp;
          deferredEntries = entryTimestamps.length - maxEntries;
          log.info(
            {
              bufferEntries: entryTimestamps.length,
              maxEntries,
              deferredEntries,
              cutoff,
            },
            "consolidation chunked: buffer over per-run cap, overflow deferred to next pass",
          );
        }
      }
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
    // bytes through the wake hint. The core-pages curation section and the
    // article SHAPE both ride the single `memory.v3.live` gate: the core-pages
    // file feeds the v3 core lane (inert on a v2-only install), and the v3
    // article shape drops the `summary:` field v2 injection depends on, so a
    // v2-only install must keep producing `summary:`-bearing fragment pages.
    const memoryV3Live = isMemoryV3Live(config);
    const prompt = resolveConsolidationPrompt(
      config.memory.v2.consolidation_prompt_path,
      cutoff,
      {
        includeCorePagesSection: memoryV3Live,
        articleShape: memoryV3Live ? "v3" : "v2",
      },
    );

    const runResult = await runBackgroundJob({
      jobName: JOB_NAME,
      source: MEMORY_V2_CONSOLIDATION_SOURCE,
      prompt,
      systemHint: "Memory consolidation",
      trustContext: { sourceChannel: "vellum", trustClass: "guardian" },
      callSite: "memoryV2Consolidation",
      timeoutMs: CONSOLIDATION_TIMEOUT_MS,
      origin: "memory_consolidation",
      suppressFailureNotifications: true,
      // Wire-scope the guardian-trust background run to local memory-file
      // tools only — no network egress, no host proxy. See the constant.
      allowedTools: CONSOLIDATION_ALLOWED_TOOLS,
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

    // Step 5: verify the run drained the buffer. `runResult.ok` only means
    // the background run completed — the trim itself is delegated to the
    // agent, and nothing above checks that it happened. A run that completes
    // without shrinking the buffer leaves the scheduler's size trigger armed
    // (it re-fires while the buffer stays over threshold), so enqueuing
    // follow-ups here would fan out one reembed per re-fire for pages that
    // never changed. Entries arriving during the run can inflate the
    // after-count into a false "no progress"; that is benign — the next
    // progressing run enqueues the same follow-ups.
    const bufferLinesAfter = countBufferLines(bufferPath);
    if (bufferLinesAfter >= bufferLinesBefore) {
      log.warn(
        {
          conversationId: runResult.conversationId,
          cutoff,
          bufferLinesBefore,
          bufferLinesAfter,
        },
        "consolidation run completed without draining the buffer; follow-ups skipped",
      );
      return {
        kind: "invoked",
        conversationId: runResult.conversationId,
        cutoff,
        deferredEntries,
        followUpJobIds: [],
        noProgress: true,
      };
    }

    // Step 6: enqueue follow-up jobs. v3 maintenance is appended only while
    // v3 is live, so it never fans out on v2-only installs. Each enqueue
    // coalesces with an already-pending job of the same type: follow-ups
    // carry no payload and read all state at execution time, so one pending
    // row covers any number of completed consolidations. A running follow-up
    // does not suppress — it may have snapshotted pre-run state, so a fresh
    // pending row must be allowed to queue behind it.
    const followUpJobIds: string[] = [];
    const jobTypes: MemoryJobType[] = [...FOLLOW_UP_JOB_TYPES];
    if (memoryV3Live) {
      jobTypes.push(V3_FOLLOW_UP_JOB_TYPE);
    }
    for (const jobType of jobTypes) {
      try {
        if (hasPendingJobOfType(jobType)) {
          log.debug(
            { jobType },
            "consolidation: follow-up already pending; skipping duplicate enqueue",
          );
          continue;
        }
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
        deferredEntries,
        followUpJobIds,
      },
      "consolidation invoked",
    );
    return {
      kind: "invoked",
      conversationId: runResult.conversationId,
      cutoff,
      deferredEntries,
      followUpJobIds,
      noProgress: false,
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
 * Extract the bracketed timestamp from a `buffer.md` entry line
 * (`- [Mon D, h:mm AM/PM] …`, see `formatBufferEntry`). Returned verbatim so
 * it can serve directly as a consolidation cutoff — both sides of the agent's
 * "timestamp ≥ cutoff" comparison then share the exact `formatBufferTimestamp`
 * shape.
 *
 * The bracket contents must match that shape exactly: a remembered fact's
 * continuation lines can themselves start with `- [` (markdown checklists
 * `- [ ] …`, wikilink bullets `- [[…]]`), and counting those as entries
 * would inflate the per-run budget — or worse, hand the agent a garbage
 * cutoff like a blank string. Returns `null` for anything that isn't a real
 * timestamped entry start.
 */
function extractBufferEntryTimestamp(line: string): string | null {
  const match = /^\s*-\s*\[([A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M)\]/.exec(
    line,
  );
  return match ? match[1] : null;
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
  return countNonEmptyLines(readBufferContent(bufferPath));
}

/** Non-empty-line count of buffer content already in hand. */
function countNonEmptyLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  return content.split("\n").filter((line) => line.trim().length > 0).length;
}

/**
 * Atomically create the lock file with `wx` (O_CREAT | O_EXCL) flags. Returns
 * `null` on success, or the current holder string (file contents, typically
 * `pid timestamp`) when the file already exists and the holder is still alive.
 *
 * Stale-lock takeover: if the file exists but its holder is stale (PID not
 * running, payload corrupt, or — for the container PID-1 collision — older
 * than the TTL; see {@link holderStaleReason}), unlink the stale file and
 * retry the create exactly once. This recovers automatically from a crashed
 * or restarted daemon that died with the lock held — otherwise every
 * subsequent scheduled consolidation would skip with `locked` indefinitely
 * until an operator manually removed the file.
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
  const staleReason = holderStaleReason(firstHolder);
  if (staleReason === null) return firstHolder;

  log.info(
    { lockPath, holder: firstHolder, reason: staleReason },
    "consolidation: taking over stale lock",
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
 * Why a lock holder is considered stale, for diagnosable takeover logs:
 *   - `unparseable`: empty / corrupt payload (partial write from a crash).
 *   - `pid_dead`: the holder's PID is no longer running.
 *   - `expired`: the lock is older than {@link STALE_LOCK_TTL_MS} even though
 *     its PID still appears alive — the PID-1 collision case in containers.
 */
type StaleReason = "unparseable" | "pid_dead" | "expired";

/**
 * Parse a `<pid> <timestamp>` holder payload (see `tryCreate`'s write).
 * Returns `null` when the PID cannot be parsed; a missing/garbled timestamp
 * yields `timestamp: null` so a partial payload still gives us the PID.
 */
function parseHolder(
  holder: string,
): { pid: number; timestamp: number | null } | null {
  const match = /^(\d+)(?:\s+(\d+))?/.exec(holder);
  if (!match) return null;
  const pid = Number.parseInt(match[1], 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const timestamp =
    match[2] !== undefined ? Number.parseInt(match[2], 10) : null;
  return {
    pid,
    timestamp:
      timestamp !== null && Number.isFinite(timestamp) ? timestamp : null,
  };
}

/**
 * Classify a holder string, returning the reason it is stale or `null` when
 * the lock is held by a live process and must be respected.
 *
 * Takeover triggers, in order:
 *   1. Unparseable / empty / `"unknown"` payload → `unparseable`. The only
 *      writer is `tryCreate`, so corruption is a partial write from a crashed
 *      prior holder, not a live writer mid-flush.
 *   2. PID not running → `pid_dead`. The fast path for a crashed daemon (or a
 *      different process now occupying that PID on a normal host).
 *   3. Lock older than {@link STALE_LOCK_TTL_MS} → `expired`. Required because
 *      the daemon runs as PID 1 in containers: after a restart the new daemon
 *      is also PID 1, so the liveness probe alone reports the holder as alive
 *      forever and could never reclaim an abandoned lock. The TTL is far above
 *      the run's hard timeout, so it never fires against an in-flight run.
 */
function holderStaleReason(holder: string): StaleReason | null {
  const parsed = parseHolder(holder);
  if (parsed === null) return "unparseable";
  if (!isProcessAlive(parsed.pid)) return "pid_dead";
  if (
    parsed.timestamp !== null &&
    Date.now() - parsed.timestamp > STALE_LOCK_TTL_MS
  ) {
    return "expired";
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
