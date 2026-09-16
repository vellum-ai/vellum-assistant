/**
 * Memory substrate — `memory_v2_consolidate` job handler.
 *
 * Shared by the v2 injection engine and memory-v3; active whenever
 * `usesConceptPageMemory()` holds.
 *
 * The consolidation job is the centerpiece of v2: an hourly background pass
 * that routes accumulated `memory/buffer.md` entries into concept pages,
 * rewrites `memory/recent.md`, and promotes new essentials/threads. The
 * buffer itself is never written by the agent: the job hands the run exactly
 * the entries it will remove, and removes them itself afterwards, so an
 * entry appended while the run is in flight is still in the buffer when it
 * ends.
 *
 * Consolidation runs as the assistant: `runBackgroundJob()` bootstraps a
 * background conversation and routes the cutoff-templated prompt through
 * `processMessage`, so the standard system prompt (SOUL.md + IDENTITY.md +
 * persona + memory/* autoloads) is loaded. Care, judgment, and the
 * assistant's voice are the point — there is no "consolidator persona" to
 * substitute in.
 *
 * The tool surface is wire-scoped to {@link CONSOLIDATION_ALLOWED_TOOLS}: local
 * file tools, a shell for corpus-wide inspection, recall, and the page-delete
 * primitive. See that constant for the surface and what it excludes.
 *
 * Lifecycle:
 *   1. Bail if memory is disabled or concept-page memory is not active
 *      (the worker may have claimed a stale row from before memory was
 *      disabled).
 *   2. Acquire a single-process lock at `memory/.v2-state/consolidation.lock`
 *      so two overlapping schedule windows can't fight over the same files.
 *      The lock contains the holder's PID + timestamp so a crashed run leaves
 *      a diagnosable trace.
 *   3. Read `memory/buffer.md` once: the snapshot. Bail if empty (no work to
 *      do, but the lock and skip path still log so operators can confirm the
 *      schedule fired).
 *   4. Select this pass's entries from the snapshot. The cutoff timestamp is
 *      captured at dispatch (and pulled back to the first over-cap entry's
 *      stamp when the buffer exceeds the per-run cap); the pass is the
 *      snapshot's leading entries up to the first one stamped with the
 *      cutoff minute. Those entries are rendered verbatim into the prompt,
 *      so what the agent files and what the job later removes are the same
 *      set by construction. An entry appended after the snapshot is never in
 *      it, and a snapshot that caught an append mid-write leaves its last
 *      entry for the next pass. Nothing eligible → bail.
 *   5. Hand off to `runBackgroundJob()` with the templated prompt. The runner
 *      handles bootstrap + processMessage + timeout + error classification,
 *      and (because we set `suppressFailureNotifications: true`) does NOT
 *      emit an `activity.failed` notification on transient failures —
 *      consolidation runs on tight intervals, so a network blip or model
 *      hiccup should not spam the home feed. Sentry-side reporting is
 *      unchanged. The prompt body is loaded via `resolveConsolidationPrompt`
 *      which bounds any operator-provided override to a regular file under
 *      1 MiB before substitution.
 *   6. Consume the pass's entries, and only then. `runResult.ok` only means
 *      the background run completed; before the job removes anything the
 *      run's persisted messages must hold at least one page-writing tool
 *      call whose result is not an error AND end with the agent's own
 *      closing reply (the pass summary the prompt mandates), the same two
 *      evidence shapes the retrospective's cursor advance uses. A run that
 *      wrote a page and then stopped mid-work has not filed its pass. With
 *      that evidence the job
 *      removes exactly the pass's entries from the live buffer through
 *      `consumeBufferEntries`, which leaves deferred entries and anything
 *      appended during the run in place. A run with no verified write, or
 *      a consume that fails, is reported as `invoked` with
 *      `noProgress: true`, enqueues no follow-ups, and leaves the buffer
 *      intact for the next pass. A failed run (provider error, exception,
 *      timeout) likewise consumes nothing. The
 *      post-run page index is also read for `danglingLinks` (structural
 *      references with no target page): reported on the outcome and in the
 *      log, and fed into the NEXT pass's prompt as a repair step like
 *      `parseFailures`. They never gate follow-ups.
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

import { getMessages } from "@vellumai/plugin-api";

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
  consumeBufferEntries,
  type ConsumeBufferEntriesResult,
} from "../buffer-file.js";
import {
  type BufferEntryLines,
  formatBufferTimestamp,
  joinBufferEntries,
  splitBufferContent,
} from "../buffer-format.js";
import { getLogger } from "../logging.js";
import {
  collectSuccessfulToolResultIds,
  countDurableToolUses,
  endsWithTextReply,
} from "../memory-run-evidence.js";
import { getWorkspaceDir } from "../paths.js";
import {
  CONSOLIDATION_TIMEOUT_MS,
  getConsolidationLockPath,
  releaseLock,
  tryAcquireLock,
} from "./consolidation-lock.js";
import { CONSOLIDATION_ALLOWED_TOOLS } from "./consolidation-tool-surface.js";
import { getPageIndex, type PageParseFailure } from "./page-index.js";
import type { DanglingLink } from "./page-links.js";
import {
  type OverlongSectionsReport,
  resolveConsolidationPrompt,
} from "./prompts/consolidation.js";
import { resolveSubstrateTuning } from "./tuning.js";

const log = getLogger("memory-v2-consolidate");

/** Stable identifier surfaced in `runBackgroundJob` logs and notifications. */
const JOB_NAME = "memory.consolidate";

/**
/**
 * Tool names whose persisted `tool_use` blocks count as durable page work
 * for the consume gate: the pass writes or edits concept pages and the
 * aggregate views through the file tools and retires pages through
 * `delete_memory_page`. The read-only tools on the allowlist do not
 * qualify, and neither does `bash`: the shell is on the surface for
 * corpus-wide inspection, and a shell call carries no evidence of what it
 * did. The prompt tells the agent to write pages with the file tools for
 * exactly this reason; a run that wrote only through the shell drains
 * nothing and reports no progress, which is loud rather than lossy.
 */
const CONSOLIDATION_DURABLE_TOOLS: ReadonlySet<string> = new Set([
  "file_write",
  "file_edit",
  "delete_memory_page",
]);

/** The shell on the consolidation surface, counted for diagnosis only. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash"]);

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
  | {
      /**
       * The buffer holds entries but none is eligible this pass: every entry
       * is stamped with the cutoff minute (or later), so the run would have
       * nothing to file. No agent run, no failure bookkeeping; the next
       * scheduler tick re-checks.
       */
      kind: "nothing_eligible";
      cutoff: string;
      deferredEntries: number;
    }
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
       * Entries this pass removed from the buffer: the entries it handed the
       * run, once the run left verified page-writing evidence. `0` when
       * `noProgress` is set.
       */
      consumedEntries: number;
      /**
       * `true` when the run completed but nothing was consumed: it left no
       * verified page write, or the consume itself failed. The buffer is
       * untouched, nothing changed worth re-embedding, and no follow-ups
       * were enqueued.
       */
      noProgress: boolean;
      /**
       * Structural references (`links:`, `[[wikilinks]]`, `edges:`) in the
       * post-run corpus whose target page does not exist; `null` when the
       * post-run index could not be read.
       */
      danglingLinks: number | null;
    };

/** Dangling links named in the post-run warn line before the count takes over. */
const MAX_LOGGED_DANGLING_LINKS = 20;

/**
 * Tier-owned inputs the job composes without importing a tier; the memory
 * plugin's job registration (`job-handlers.ts`) supplies them.
 */
export interface ConsolidationJobDeps {
  /**
   * Sections over the section-grain retrieval window, for the prompt's
   * over-long-sections repair step. Read only where memory-v3 is live, since
   * the window is v3's; a missing or failing lister omits the step. Like the
   * other repair steps it rides a buffer-driven pass: an empty buffer skips
   * the run, repairs included, so no LLM pass is spent on a workspace with
   * nothing new to file, and a quiet workspace's backlog waits for its next
   * real pass. An over-long section stays retrievable meanwhile, chunk by
   * chunk.
   */
  listOverlongSections?: (
    workspaceDir: string,
  ) => Promise<OverlongSectionsReport>;
}

export async function memoryV2ConsolidateJob(
  _job: MemoryJob,
  config: AssistantConfig,
  deps: ConsolidationJobDeps = {},
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

    // The snapshot. Everything this pass files and later removes comes from
    // it; an entry appended after this read is by construction not in it.
    const snapshot = splitBufferContent(bufferContent);

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
      const entryTimestamps = snapshot
        .map((entry) => entry.start?.timestamp ?? null)
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

    // The pass: the snapshot's leading entries up to the first one stamped
    // with the cutoff minute, rendered verbatim into the prompt and removed
    // by this job once the run has filed them.
    const pass = selectPassEntries(
      snapshot,
      cutoff,
      await snapshotIsComplete(bufferPath, bufferContent),
    );
    if (pass.length === 0) {
      log.info(
        { cutoff, bufferEntries: snapshot.length },
        "consolidation skipped: no buffer entry is eligible this pass (all stamped at or after the cutoff, or still being appended)",
      );
      return { kind: "nothing_eligible", cutoff, deferredEntries };
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
    // (unterminated fence), and structural references with no target page,
    // rendered into the prompt's repair steps so the agent fixes them this
    // pass. Best-effort: prompt assembly must never fail because the index
    // build did.
    let parseFailures: PageParseFailure[] = [];
    let danglingLinks: DanglingLink[] = [];
    try {
      const index = await getPageIndex(getWorkspaceDir());
      parseFailures = index.parseFailures;
      danglingLinks = index.danglingLinks;
    } catch (err) {
      log.warn(
        { err },
        "consolidation: page-index read failed; omitting the repair sections",
      );
    }
    // Sections the v3 chunker splits, rendered into the prompt's over-long
    // sections repair step so the agent splits them at the page. Best-effort
    // like the index read above.
    let overlongSections: OverlongSectionsReport | undefined;
    if (memoryV3Live && deps.listOverlongSections) {
      try {
        overlongSections = await deps.listOverlongSections(getWorkspaceDir());
      } catch (err) {
        log.warn(
          { err },
          "consolidation: over-long section scan failed; omitting the repair step",
        );
      }
    }
    const prompt = resolveConsolidationPrompt(
      tuning.consolidation_prompt_path,
      cutoff,
      {
        includeCorePagesSection: memoryV3Live,
        articleShape: memoryV3Live ? "v3" : "v2",
        bufferEntries: joinBufferEntries(pass),
        parseFailures,
        danglingLinks,
        overlongSections,
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
        runResult.turnFailure?.failureCode === "PROVIDER_BILLING"
          ? "billing"
          : "transient";
      log.error(
        {
          conversationId: runResult.conversationId,
          errorKind: runResult.errorKind,
          failureCode: runResult.turnFailure?.failureCode,
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

    // Step 5: consume the pass's entries, gated on evidence. `runResult.ok`
    // only means the background run completed. Before removing anything the
    // job requires two things of the run's persisted messages: at least one
    // page-writing tool call whose result is not an error (a run that
    // answered in prose, or whose writes all failed, filed nothing), and a
    // closing reply in the agent's own words as the run's final row, with
    // no tool call on it (a run that wrote a page, say a repair-step fix,
    // and then stopped mid-work has not filed its pass, and narration on
    // the row that called the tool is not a conclusion; the prompt mandates
    // the pass summary, so its absence is the run ending early). Either missing, and
    // consuming would delete entries unfiled. A skipped run never invoked
    // the agent, so it consumes nothing either. With both, the consume
    // removes exactly the pass's entries and leaves every other entry
    // (deferred past the cap, or appended during the run) in place.
    let consumed: ConsumeBufferEntriesResult | null = null;
    let evidence: RunEvidence = {
      durableWrites: 0,
      shellCalls: 0,
      concluded: false,
    };
    if (runResult.skipReason === undefined) {
      evidence = await readRunEvidence(runResult.conversationId);
      if (evidence.durableWrites > 0 && evidence.concluded) {
        try {
          consumed = await consumeBufferEntries(bufferPath, pass);
        } catch (err) {
          // Thrown only before the rename commits, so the buffer still holds
          // the pass.
          log.error(
            { err, conversationId: runResult.conversationId },
            "consolidation: buffer consume failed before rewriting; entries left for the next pass",
          );
        }
      }
    }
    const noProgress = consumed === null;
    if (consumed !== null && consumed.lateAppendDrainFailed) {
      log.error(
        { conversationId: runResult.conversationId },
        "consolidation: the replaced buffer inode could not be read after the rewrite; any entry appended during it is in the daily archive only",
      );
    }
    if (consumed !== null && consumed.unrecoveredLateAppendBytes > 0) {
      // The pass is consumed (the rename committed) but bytes an appender
      // landed on the replaced inode could not be copied back. Those
      // entries are still in memory/archive/<date>.md, written by the same
      // append that wrote them to the buffer.
      log.error(
        {
          conversationId: runResult.conversationId,
          unrecoveredLateAppendBytes: consumed.unrecoveredLateAppendBytes,
        },
        "consolidation: entries appended during the buffer rewrite could not be copied back into buffer.md; they remain in the daily archive only",
      );
    }
    if (consumed !== null && consumed.alreadyAbsent > 0) {
      // Only appenders are expected to touch the buffer during a run. An
      // entry the job handed the run but cannot find afterwards was removed
      // by something else, most likely a customized prompt that still
      // rewrites `memory/buffer.md`; that rewrite carries the stale-read
      // hazard this job exists to avoid.
      log.warn(
        {
          conversationId: runResult.conversationId,
          alreadyAbsent: consumed.alreadyAbsent,
          removed: consumed.removed,
        },
        "consolidation: some of this pass's entries were already gone from buffer.md; the agent must not rewrite the buffer",
      );
    }

    // The agent's file-tool writes invalidate the page index, so this read
    // sees the post-run corpus.
    const danglingAfter = await readDanglingLinks(
      runResult.conversationId,
      danglingLinks.length,
    );

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
          passEntries: pass.length,
          durableWrites: evidence.durableWrites,
          shellCalls: evidence.shellCalls,
          concluded: evidence.concluded,
          skipReason: runResult.skipReason,
        },
        evidence.durableWrites === 0 && evidence.shellCalls > 0
          ? "consolidation run wrote no pages through the file tools (it used the shell); buffer left intact, follow-ups skipped"
          : "consolidation run completed without a verified page write and a closing reply; buffer left intact, follow-ups skipped",
      );
      return {
        kind: "invoked",
        conversationId: runResult.conversationId,
        cutoff,
        deferredEntries,
        followUpJobIds: [],
        consumedEntries: 0,
        noProgress: true,
        danglingLinks: danglingAfter,
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
        consumedEntries: pass.length,
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
      consumedEntries: pass.length,
      noProgress: false,
      danglingLinks: danglingAfter,
    };
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Post-run dangling-link count; warns (with a capped sample and the pre-run
 * count) when any remain. `null` when the index cannot be read.
 */
async function readDanglingLinks(
  conversationId: string,
  danglingBefore: number,
): Promise<number | null> {
  let dangling: DanglingLink[];
  try {
    dangling = (await getPageIndex(getWorkspaceDir())).danglingLinks;
  } catch (err) {
    log.warn(
      { err, conversationId },
      "consolidation: post-run page-index read failed; dangling links unknown",
    );
    return null;
  }
  if (dangling.length > 0) {
    log.warn(
      {
        conversationId,
        danglingBefore,
        danglingAfter: dangling.length,
        sample: dangling
          .slice(0, MAX_LOGGED_DANGLING_LINKS)
          .map((d) => `${d.from} -> ${d.to} (${d.kind})`),
      },
      "consolidation left structural links whose target page does not exist; the next pass renders them as a repair step",
    );
  }
  return dangling.length;
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
 * The entries this pass files: the snapshot's leading entries up to (not
 * including) the first one stamped with the cutoff minute. In an append-only
 * buffer that is exactly the set the prompt describes as "timestamp <
 * cutoff", but chosen by position, so the job and the prompt name the same
 * entries whatever the model makes of the dates. A same-minute pull-back
 * (the chunking cutoff) works the same way: entries sharing the over-cap
 * entry's minute are deferred with it.
 *
 * Prose before the first entry opening (a hand-written buffer) is filed too,
 * when it holds any text; otherwise the buffer could never drain.
 *
 * A snapshot that caught an append mid-write (`snapshotIsComplete` false,
 * see {@link snapshotIsComplete}) has an incomplete last entry, which is
 * left for the next pass rather than filed and removed in a truncated form.
 */
function selectPassEntries(
  snapshot: readonly BufferEntryLines[],
  cutoff: string,
  snapshotIsComplete: boolean,
): BufferEntryLines[] {
  const pass: BufferEntryLines[] = [];
  for (const entry of snapshot) {
    if (entry.start === null) {
      if (entry.lines.some((line) => line.trim().length > 0)) {
        pass.push(entry);
      }
      continue;
    }
    if (entry.start.timestamp === cutoff) {
      break;
    }
    pass.push(entry);
  }
  const last = pass[pass.length - 1];
  if (
    last !== undefined &&
    last === snapshot[snapshot.length - 1] &&
    !snapshotIsComplete
  ) {
    pass.pop();
  }
  return pass;
}

/**
 * How long an unterminated snapshot is given to settle before it is read
 * again. An in-flight append completes within microseconds; a re-read that
 * still returns the same bytes after this is a stable file.
 */
const UNTERMINATED_SNAPSHOT_SETTLE_MS = 100;

/**
 * Whether the snapshot ends on a complete entry. An append is one write
 * ending in a newline, so content that ends in one is complete. Content
 * that does not is either an append caught mid-write or a buffer whose last
 * rewrite left no terminator (an agent's `file_write` under an older prompt,
 * a hand edit): a persisted shape that must keep working. The two are told
 * apart by time: after a short settle the file is read again, and identical
 * bytes mean nothing was mid-write, so the last entry is complete and may be
 * filed. Grown or changed bytes mean an append was in flight, and the
 * snapshot's last entry waits for the next pass. Consuming rewrites the
 * buffer newline-terminated, so the unterminated shape does not recur.
 */
async function snapshotIsComplete(
  bufferPath: string,
  content: string,
): Promise<boolean> {
  if (content.endsWith("\n")) {
    return true;
  }
  await new Promise((resolve) =>
    setTimeout(resolve, UNTERMINATED_SNAPSHOT_SETTLE_MS),
  );
  return readBufferContent(bufferPath) === content;
}

interface RunEvidence {
  /** Page-writing tool calls whose execution verifiably succeeded. */
  durableWrites: number;
  /**
   * Shell calls the run made, successful or not. Never evidence of filing
   * (a shell call carries no record of what it did); reported so a run
   * that wrote its pages through the shell is diagnosable from the log.
   */
  shellCalls: number;
  /**
   * The run's final row is an assistant reply in its own words, with no
   * tool call on it: the shape of a run the model ended itself.
   */
  concluded: boolean;
}

/**
 * What the run's conversation proves it did: page-writing tool calls with
 * a matching non-error `tool_result`, and whether the run ended by replying
 * (the pass summary) rather than stopping mid-tool-loop. A consolidation
 * conversation is bootstrapped fresh per run, so every message in it is
 * the run's own. A load failure reports nothing: the consume gate then
 * fails closed and the buffer waits for the next pass.
 */
async function readRunEvidence(conversationId: string): Promise<RunEvidence> {
  let messages: Awaited<ReturnType<typeof getMessages>>;
  try {
    messages = await getMessages(conversationId);
  } catch (err) {
    log.warn(
      { err, conversationId },
      "consolidation: failed to load the run's messages; treating the run as having filed nothing",
    );
    return { durableWrites: 0, shellCalls: 0, concluded: false };
  }
  return {
    durableWrites: countDurableToolUses(
      messages,
      CONSOLIDATION_DURABLE_TOOLS,
      collectSuccessfulToolResultIds(messages),
    ),
    shellCalls: countDurableToolUses(messages, SHELL_TOOLS, null),
    concluded: endsWithTextReply(messages),
  };
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
