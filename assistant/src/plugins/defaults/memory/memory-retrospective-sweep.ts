// ---------------------------------------------------------------------------
// Memory retrospective — scheduled sweep (timer-driven backstop).
// ---------------------------------------------------------------------------
//
// The event-driven retrospective triggers (`interval` / `message_count` /
// `compaction`) are all evaluated from within an agent turn — the post-turn
// indexing hook and the compaction site. They fire reliably while a
// conversation keeps taking turns. But a turn that ends abnormally (daemon
// crash, IPC drop) never reaches its post-turn hooks, so its unprocessed
// messages are left with no pending retrospective; if that conversation is
// then never resumed, the event triggers never re-evaluate it and the messages
// stay unprocessed indefinitely.
//
// This sweep is the backstop for exactly that gap. It runs as a scheduled job
// (`memory_retrospective_sweep`, enqueued on a durable-checkpoint cadence from
// `jobs-worker.ts`) and re-scans conversations for unprocessed messages,
// enqueuing a retrospective for any the event triggers missed. It replaces the
// former conversation-disposal safety-net: disposal only runs on graceful
// eviction, so it shares the very failure mode (process death before the
// path runs) it was meant to cover — a timer does not.
//
// Eligibility mirrors the event-driven path's gates so the sweep enqueues
// exactly what a completed turn would have: memory-trusted actor only
// (`isMemoryTrustedConversation`, matching `indexer.ts`'s `isTrustedActor` —
// the retrospective runs under guardian trust with `remember`, so untrusted
// contact content must never reach it) and no recursion/low-yield sources
// (filtered in `EXCLUDED_SOURCES`).
//
// Cost discipline:
//   - The per-conversation gate skips any conversation whose last retrospective
//     attempt is newer than the sweep interval, so the sweep never competes
//     with the responsive event triggers on active conversations — it only
//     picks up genuinely stalled ones.
//   - Enqueues route through `enqueueMemoryRetrospectiveIfEnabled`, whose
//     `upsertMemoryRetrospectiveJob` coalesces against any already-pending job,
//     so a conversation already queued by an event trigger is never
//     double-processed.
//   - The scan is keyset-paginated in bounded batches with a yield between
//     pages (mirrors `conversation-memory-orphan-sweep.ts`), so a large history
//     never materializes all ids at once or holds the event loop. Every
//     eligible conversation is examined each pass — there is no front-of-list
//     limit that could starve later conversations.

import { and, asc, gt, ne, notInArray } from "drizzle-orm";

import type { AssistantConfig } from "../../../config/types.js";
import { AUTO_ANALYSIS_SOURCE } from "../../../persistence/auto-analysis-constants.js";
import { getConversationRecentProvenanceTrustClass } from "../../../persistence/conversation-crud.js";
import { getDb } from "../../../persistence/db-connection.js";
import type { MemoryJob } from "../../../persistence/jobs-store.js";
import { isMemoryEnabled } from "../../../persistence/jobs-store.js";
import { conversations } from "../../../persistence/schema/index.js";
import { getLogger } from "./logging.js";
import { countRetrospectiveMessagesAfter } from "./memory-retrospective-accounting.js";
import { MEMORY_RETROSPECTIVE_SOURCES } from "./memory-retrospective-constants.js";
import { enqueueMemoryRetrospectiveIfEnabled } from "./memory-retrospective-enqueue.js";
import { getRetrospectiveState } from "./memory-retrospective-state.js";
import { MEMORY_V2_CONSOLIDATION_SOURCE } from "./v3/substrate/constants.js";

const log = getLogger("memory-retrospective-sweep");

/** Rows per keyset-paginated page — bounds each statement and the id set held. */
const SWEEP_BATCH = 200;

/**
 * Conversation `source` values excluded from the sweep up front:
 *   - retrospective background conversations — recursion guard (never run a
 *     retrospective over the retrospective agent's own writes);
 *   - consolidation sources — low-yield skip (already persisted to the corpus);
 *   - auto-analysis conversations — recursion guard mirroring the
 *     `!isAutoAnalysisSource` gate the event triggers apply (the analysis agent
 *     wrote memory directly, so retrospecting its reflective output double-writes).
 * The first two mirror guards `enqueueMemoryRetrospectiveIfEnabled` re-applies;
 * auto-analysis is filtered here because the enqueue does not check it. Cheap
 * SQL prefilter — the enqueue remains authoritative for the sources it covers.
 */
const EXCLUDED_SOURCES: string[] = [
  ...MEMORY_RETROSPECTIVE_SOURCES,
  MEMORY_V2_CONSOLIDATION_SOURCE,
  AUTO_ANALYSIS_SOURCE,
];

/**
 * Whether a conversation's actor is trusted to write into long-term memory.
 * Mirrors the `isTrustedActor` gate in `indexer.ts`: only guardian-authored
 * conversations and legacy conversations with no recorded provenance
 * (predominantly desktop-origin guardian threads, which don't stamp
 * provenance) are trusted. Contact-audience conversations (trusted_contact /
 * unverified_contact / unknown) are excluded — the retrospective job runs
 * under guardian trust with `remember`, so sweeping an untrusted conversation
 * would write its content into memory across the memory trust boundary.
 *
 * This is the timer-path equivalent of the trust gate the event triggers
 * apply per message (`isTrustedActor`) and the disposal net applied via
 * `resolveCapabilities(...).canAccessMemory`; it must match the event triggers'
 * `guardian || undefined` semantic rather than `canAccessMemory` so the sweep
 * still backs up legacy/desktop guardian conversations (whose provenance is
 * `undefined`), which `resolveCapabilities(undefined)` would wrongly exclude.
 */
export function isMemoryTrustedConversation(conversationId: string): boolean {
  const trustClass = getConversationRecentProvenanceTrustClass(conversationId);
  return trustClass === "guardian" || trustClass === undefined;
}

/** Yield to the event loop so a large backlog never blocks it. */
function breathe(): Promise<void> {
  return Bun.sleep(0);
}

/**
 * One keyset page of sweep-eligible conversation ids past `cursor`. The empty
 * string sorts before any real id, so the first page starts at the beginning.
 * `scheduled`-type conversations are filtered here (low-yield, matching the
 * enqueue guard); other low-yield cases are caught by the enqueue itself.
 */
export function listSweepCandidateConversationIds(
  cursor: string,
  limit: number,
): string[] {
  return getDb()
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        gt(conversations.id, cursor),
        notInArray(conversations.source, EXCLUDED_SOURCES),
        ne(conversations.conversationType, "scheduled"),
      ),
    )
    .orderBy(asc(conversations.id))
    .limit(limit)
    .all()
    .map((row) => row.id);
}

export interface RetrospectiveSweepResult {
  /** Conversations examined across every page. */
  scanned: number;
  /** Conversations for which a retrospective was enqueued this pass. */
  enqueued: number;
}

/**
 * Scan all sweep-eligible conversations and enqueue a `sweep`-triggered
 * retrospective for any with unprocessed messages whose last attempt is older
 * than `sweepIntervalMs`. Idempotent and best-effort: enqueue coalescing
 * prevents duplicates, and the scan degrades to a no-op when memory is
 * disabled.
 */
export async function runRetrospectiveSweep(
  config: AssistantConfig,
  now: number = Date.now(),
): Promise<RetrospectiveSweepResult> {
  if (!isMemoryEnabled()) {
    return { scanned: 0, enqueued: 0 };
  }
  const sweepIntervalMs = config.memory.retrospective.sweepIntervalMs;

  let scanned = 0;
  let enqueued = 0;
  let cursor = "";
  for (;;) {
    const page = listSweepCandidateConversationIds(cursor, SWEEP_BATCH);
    if (page.length === 0) {
      break;
    }
    cursor = page[page.length - 1]!;

    for (const conversationId of page) {
      scanned += 1;

      // Memory trust boundary: never enqueue a retrospective (which runs under
      // guardian trust with `remember`) for a conversation whose actor isn't
      // memory-trusted. This is the sweep's equivalent of the per-message
      // `isTrustedActor` gate the event triggers apply and the disposal net's
      // capability check — without it the timer path would write untrusted
      // contact content into long-term memory.
      if (!isMemoryTrustedConversation(conversationId)) {
        continue;
      }

      // Skip conversations the event triggers are still actively covering: a
      // last attempt within one sweep interval means the responsive path has
      // it in hand. Never-run conversations (no state) fall through to the
      // unprocessed-message check.
      const state = getRetrospectiveState(conversationId);
      if (state && now - state.lastRunAt < sweepIntervalMs) {
        continue;
      }

      const unprocessed = countRetrospectiveMessagesAfter(
        conversationId,
        state?.lastProcessedMessageId ?? null,
      );
      if (unprocessed === 0) {
        continue;
      }

      enqueueMemoryRetrospectiveIfEnabled({ conversationId, trigger: "sweep" });
      enqueued += 1;
    }

    await breathe();
    if (page.length < SWEEP_BATCH) {
      break;
    }
  }

  if (enqueued > 0) {
    log.info(
      { scanned, enqueued },
      "Memory retrospective sweep enqueued backstop jobs",
    );
  } else {
    log.debug({ scanned }, "Memory retrospective sweep found no stalled work");
  }
  return { scanned, enqueued };
}

/**
 * Job handler for `memory_retrospective_sweep`. Thin wrapper over
 * {@link runRetrospectiveSweep} — the scheduler enqueues the job on the
 * configured cadence; the scan work happens here, off the scheduler tick.
 */
export async function memoryRetrospectiveSweepJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const result = await runRetrospectiveSweep(config);
  log.debug(
    { jobId: job.id, ...result },
    "Memory retrospective sweep job complete",
  );
}
