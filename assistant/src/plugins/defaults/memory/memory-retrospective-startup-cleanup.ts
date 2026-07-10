// ---------------------------------------------------------------------------
// Memory retrospective — startup orphan cleanup.
// ---------------------------------------------------------------------------
//
// When the daemon crashes mid-retrospective, the bootstrapped background
// conversation lingers in the `conversations` table (and possibly the
// `messages` table) as an orphan. The jobs-store recovery
// (`resetRunningJobsToPending`) handles re-running the job, which bootstraps
// a NEW background conversation — but the previous one is never deleted
// because the original handler's cleanup path didn't get a chance to run.
//
// This module sweeps those orphans on daemon startup. Run AFTER
// `resetRunningJobsToPending` so legitimate in-flight retries (which are
// represented by their pending job row, not by a memory-retrospective
// conversation directly) aren't swept.
//
// Sweep predicate:
//   - `source = "memory-retrospective"`, AND
//   - `last_message_at < now - 1 hour` (so a freshly-running job's
//     conversation isn't swept on a startup that happens to race),
//   - AND no pending OR running `memory_retrospective` job exists. (The
//     orphan background conversation references the SOURCE conversation
//     via the wake hint; if a job exists for that source, the background
//     conversation might be the active one. We're conservative and only
//     sweep when no job exists at all, since the worst-case false-positive
//     is leaving a few extra orphans for the next sweep to catch.)
//   - AND the row is NOT the preserved dedup baseline for its source
//     conversation. The primary dedup baseline is the persisted
//     `remembered_log` on `memory_retrospective_state`, but state rows that
//     predate the log column fall back to scanning the most-recent prior
//     retro (via `findMostRecentRetrospectiveFor`) to seed their
//     `<already_remembered>` dedup block; sweeping it would force such a
//     run to re-save facts the prior pass already captured. The baseline is
//     the most recent row that actually produced output (see
//     `selectPreservedBaseline`) — a crash orphan with no post-fork
//     assistant message would seed an EMPTY dedup block, so when an older
//     row with output exists we preserve that one instead.
//
// The sweep is skipped entirely when `memory.retrospective.keepSupersededRuns`
// is true — see the comment inside the function.

import { deleteConversation } from "@vellumai/plugin-api";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import { getDb, getMemoryDb } from "../../../persistence/db-connection.js";
import {
  conversations,
  memoryJobs,
} from "../../../persistence/schema/index.js";
import { getLogger } from "../../../util/logger.js";
import { getMemoryConfig } from "./config.js";
import { MEMORY_RETROSPECTIVE_SOURCES } from "./memory-retrospective-constants.js";
import { loadRetrospectiveRunMessages } from "./memory-retrospective-fork-boundary.js";

const log = getLogger("memory-retrospective-startup-cleanup");

const ORPHAN_AGE_MS = 60 * 60 * 1000;

/**
 * How many of the newest retrospective rows per source the baseline selector
 * will load messages for when looking for one with output. Bounds the
 * per-startup query volume — after GC (`deleteSupersededPriorRetrospective`)
 * a source normally has 1–2 retro rows, so this only matters for pathological
 * crash pileups, where the older rows are orphans too.
 */
const MAX_BASELINE_CANDIDATES_PER_SOURCE = 3;

export interface CleanupResult {
  swept: number;
}

/**
 * Find and delete orphan memory-retrospective background conversations.
 * Idempotent — safe to call repeatedly. Returns the number of conversations
 * deleted. Best-effort: errors deleting individual rows are logged and the
 * sweep continues.
 */
export async function sweepOrphanMemoryRetrospectiveConversations(
  now: number = Date.now(),
): Promise<CleanupResult> {
  // When the operator opted into retaining superseded retrospective runs
  // (`memory.retrospective.keepSupersededRuns`), skip the sweep entirely —
  // retained runs must survive restarts, and the sweep cannot distinguish a
  // retained superseded run from a crash orphan. Tradeoff: under this opt-in,
  // genuine crash orphans persist too. That's acceptable — the operator asked
  // for full run history, and an orphan is just one more retained conversation.
  if (getMemoryConfig()?.retrospective?.keepSupersededRuns === true) {
    return { swept: 0 };
  }

  const cutoff = now - ORPHAN_AGE_MS;
  const db = getDb();

  // `memory_jobs` lives on the dedicated memory connection. If it is unavailable
  // we cannot tell which sources have in-flight retrospective jobs, so skip the
  // sweep rather than risk deleting a conversation whose job is still running.
  const memoryDb = getMemoryDb();
  if (!memoryDb) {
    return { swept: 0 };
  }

  // Job payloads encode the SOURCE conversation id (the conversation being
  // analyzed), not the background-conversation id of the retrospective itself.
  // The background conversation links back to its source via
  // `forkParentConversationId` (set when bootstrapped — see
  // memory-retrospective-job.ts). To protect in-flight jobs we therefore
  // compare source-id to source-id by filtering on
  // `conversations.forkParentConversationId`, not `conversations.id`.
  const activeJobSourceConversationIds = memoryDb
    .select({
      conversationId: sql<string>`json_extract(${memoryJobs.payload}, '$.conversationId')`,
    })
    .from(memoryJobs)
    .where(
      and(
        eq(memoryJobs.type, "memory_retrospective"),
        inArray(memoryJobs.status, ["pending", "running"]),
      ),
    )
    .all()
    .map((row) => row.conversationId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  // Compute the preserved dedup baseline per source. Runs whose state row
  // predates the persisted `remembered_log` pull dedup context by scanning
  // the most-recent prior retro (via `findMostRecentRetrospectiveFor`);
  // sweeping it would leave those runs with no baseline at all.
  const allRetros = db
    .select({
      id: conversations.id,
      source: conversations.source,
      forkParentConversationId: conversations.forkParentConversationId,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(
      and(
        inArray(conversations.source, MEMORY_RETROSPECTIVE_SOURCES),
        isNotNull(conversations.forkParentConversationId),
      ),
    )
    .all();
  const retrosPerSource = new Map<string, RetroRow[]>();
  for (const row of allRetros) {
    const parent = row.forkParentConversationId;
    if (parent === null) {
      continue;
    }
    const rows = retrosPerSource.get(parent);
    if (rows) {
      rows.push(row);
    } else {
      retrosPerSource.set(parent, [row]);
    }
  }
  const preservedIds = new Set<string>();
  for (const rows of retrosPerSource.values()) {
    preservedIds.add(await selectPreservedBaseline(rows));
  }

  const orphans = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        inArray(conversations.source, MEMORY_RETROSPECTIVE_SOURCES),
        // Conservative: only sweep rows that have had at least one message
        // AND haven't seen activity recently. Conversations without a
        // last_message_at value are too fresh to assess.
        isNotNull(conversations.lastMessageAt),
        lt(conversations.lastMessageAt, cutoff),
        activeJobSourceConversationIds.length > 0
          ? // `forkParentConversationId` is nullable, and SQLite's
            // `NULL NOT IN (...)` evaluates to unknown (falsy), so legacy
            // rows with a null parent would never match. Include them
            // explicitly so the sweep covers them.
            or(
              isNull(conversations.forkParentConversationId),
              notInArray(
                conversations.forkParentConversationId,
                activeJobSourceConversationIds,
              ),
            )
          : sql`1=1`,
      ),
    )
    .all()
    .filter((row) => !preservedIds.has(row.id));

  let swept = 0;
  for (const row of orphans) {
    try {
      await deleteConversation(row.id);
      swept++;
    } catch (err) {
      log.warn(
        { err, conversationId: row.id },
        "Failed to delete orphan memory-retrospective conversation; continuing",
      );
    }
  }
  if (swept > 0) {
    log.info(
      { swept, cutoff },
      "Swept orphan memory-retrospective background conversations",
    );
  }
  return { swept };
}

interface RetroRow {
  id: string;
  source: string | null;
  createdAt: number;
}

/**
 * Pick which retrospective row to preserve as the source's dedup baseline:
 * the most recent row that actually produced output (a crash orphan with no
 * post-fork assistant message would seed the next run with an EMPTY
 * `<already_remembered>` block and cause re-saves). Falls back to the plain
 * most-recent row when no candidate qualifies — preserves the previous
 * behavior when every row is an orphan, and an orphan baseline at least
 * keeps `findMostRecentRetrospectiveFor` stable until a successful run
 * supersedes it.
 *
 * PR-E's persisted `remembered_log` reduces the impact of preserving a bad
 * baseline (the next run can fall back to the persisted log), but the log
 * fallback path still reads the preserved conversation, so the sweep should
 * keep preferring a row that's actually useful.
 *
 * Only loads messages for the newest `MAX_BASELINE_CANDIDATES_PER_SOURCE`
 * rows — never for every retro row.
 */
async function selectPreservedBaseline(rows: RetroRow[]): Promise<string> {
  const sorted = [...rows].sort((a, b) => b.createdAt - a.createdAt);
  for (const row of sorted.slice(0, MAX_BASELINE_CANDIDATES_PER_SOURCE)) {
    if (await retrospectiveHasOutput(row)) {
      return row.id;
    }
  }
  return sorted[0]!.id;
}

/**
 * Whether the retrospective row produced any assistant output of its own.
 * `loadRetrospectiveRunMessages` scopes fork-kind rows to the post-fork tail
 * (the copied source prefix contains the source's own assistant turns) and
 * returns `null` for rows whose output cannot be determined (load failure or
 * no detectable fork boundary) — those rows contribute nothing to dedup
 * (`collectPriorRetrospectiveRemembers` treats them as empty), so they don't
 * qualify. Legacy-kind rows start empty, so any assistant message counts.
 */
async function retrospectiveHasOutput(row: RetroRow): Promise<boolean> {
  const runMessages = await loadRetrospectiveRunMessages(row.id, row.source);
  if (runMessages == null) {
    return false;
  }
  return runMessages.some((m) => m.role === "assistant");
}
