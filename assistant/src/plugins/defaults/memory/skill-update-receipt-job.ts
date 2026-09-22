// ---------------------------------------------------------------------------
// Memory retrospective: skill-update receipts.
// ---------------------------------------------------------------------------
//
// A background pass can rewrite several managed skills within minutes. A
// receipt collapses one such burst into one announcement: every rewrite is
// appended to the one pending `skill_update_receipt` job
// (`upsertSkillUpdateReceiptJob`), and this handler announces the burst once
// it has settled, through `emitNotificationSignal`, the single entry point
// every notification producer uses. The same shape as the skill card's
// delivery job, keyed to a burst rather than to a run.
//
// Settled means every run that contributed an entry has finished (its fork
// conversation is no longer processing, or is gone) and no entry has landed
// for the quiet window. A burst that never goes quiet is announced at the
// cap, measured from its earliest entry. Until then the handler re-upserts
// the payload for a later check, the way the card defers until its run ends,
// so no attempt counter accumulates.
//
// The pending-only match in the upsert is what makes a burst boundary
// possible without a table of its own, and also what bounds it. The claimed
// row's payload is frozen, so an entry landing during evaluation opens a
// pending sibling; the handler checks for one right before announcing and,
// if it finds one, merges its own entries into it and announces nothing,
// leaving the sibling to carry the whole burst. Two windows stay open, and
// both surface as a second bell row rather than a lost entry: an entry
// landing between that check and the announcement's event row, and a
// sibling claimed by another worker between the check and the merge, in
// which case the merge opens a third row. Both are accepted.
//
// One announcement per row: the dedupe key is the row id, so a retry after a
// crash past the event row meets the key and completes. A pipeline failure
// before that is reported as retryable and the worker's own budget covers
// it; a row that exhausts it loses its entries, as the per-update notice it
// replaces would have.

import {
  getConversation,
  isConversationProcessing,
} from "@vellumai/plugin-api";

import { emitNotificationSignal } from "../../../notifications/emit-signal.js";
import {
  hasPendingJobOfType,
  type MemoryJob,
  parseSkillUpdateReceiptPayload,
  type SkillUpdateReceiptEntry,
  type SkillUpdateReceiptJobPayload,
  upsertSkillUpdateReceiptJob,
} from "../../../persistence/jobs-store.js";
import type { JobQueueResolution } from "../../types.js";
import { getLogger } from "./logging.js";

const log = getLogger("skill-update-receipt-job");

/**
 * How long a receipt stays open after its last entry before it is announced.
 * Equal to the retrospective's default interval trigger, so runs a
 * conversation's message count keeps triggering (at most every five minutes)
 * chain into one receipt, while interval-driven runs of a slow conversation
 * each get their own.
 */
export const SKILL_UPDATE_RECEIPT_QUIET_MS = 30 * 60 * 1000;

/**
 * The longest a receipt stays open, measured from its earliest entry. A
 * burst that never goes quiet is announced at the cap and a later entry
 * opens the next receipt.
 */
export const SKILL_UPDATE_RECEIPT_CAP_MS = 2 * 60 * 60 * 1000;

/**
 * How soon the handler looks again at a receipt whose contributing run is
 * still live. The run's end is what it waits for, and a run is one wake, so a
 * short cadence catches it without polling hard.
 */
export const SKILL_UPDATE_RECEIPT_LIVE_RUN_RECHECK_MS = 30_000;

/**
 * Record one rewrite on the open receipt and make sure a check is queued.
 * Called by the scaffold tool after a background overwrite lands. Throws on
 * a store failure; the caller logs it and lets the skill write stand.
 */
export function recordSkillUpdate(
  entry: Omit<SkillUpdateReceiptEntry, "createdAt">,
  now: number = Date.now(),
): void {
  upsertSkillUpdateReceiptJob(
    {
      firstEntryAt: now,
      lastEntryAt: now,
      entries: [{ ...entry, createdAt: now }],
    },
    now + SKILL_UPDATE_RECEIPT_QUIET_MS,
  );
}

/** The dedupe key a receipt row is announced under. */
export function skillUpdateReceiptDedupeKey(jobId: string): string {
  return `skill-update-receipt:${jobId}`;
}

/**
 * The `sourceContextId` a receipt is announced with. The home feed's "Go to
 * Conversation" and the vellum delivery's body append both resolve it to a
 * conversation, so a receipt whose rewrites all came from one conversation
 * names it; one spanning several, or with a rewrite of unknown lineage,
 * passes a sentinel that resolves to nothing, and the receipt's own entries
 * carry the links.
 */
export function skillUpdateReceiptSourceContextId(
  jobId: string,
  entries: SkillUpdateReceiptEntry[],
): string {
  // An entry with no lineage counts as its own source: linking the whole
  // receipt to the one known conversation would attribute that rewrite
  // there too.
  const sources = new Set(entries.map((entry) => entry.sourceConversationId));
  const [only] = sources;
  return sources.size === 1 && only ? only : `skill-update-receipt:${jobId}`;
}

/**
 * The English fallback title and body, for a surface that renders the item
 * as it arrived: a bundle without the receipt panel, a channel post, a
 * banner. The web client derives its own title from the entries.
 */
export function composeSkillUpdateReceiptCopy(
  entries: SkillUpdateReceiptEntry[],
): { title: string; body: string } {
  const skills = new Map<string, string>();
  for (const entry of entries) {
    skills.set(entry.skillId, entry.name);
  }
  const names = [...skills.values()];
  const title =
    names.length === 1
      ? `Skill updated: ${names[0]}`
      : `${names.length} skills updated`;
  const body = entries
    .map((entry) => `- ${entry.name}: ${entry.changeSummary}`)
    .join("\n");
  return { title, body };
}

export type SkillUpdateReceiptSealDecision =
  | { seal: "quiet" | "cap" }
  | { seal: null; nextCheckAt: number };

/**
 * Whether the receipt is due to be announced, and if not, when to look
 * again. Pure, so the boundary can be asserted without a clock or a queue.
 */
export function decideSkillUpdateReceiptSeal(args: {
  receipt: Pick<SkillUpdateReceiptJobPayload, "firstEntryAt" | "lastEntryAt">;
  anyRunLive: boolean;
  now: number;
}): SkillUpdateReceiptSealDecision {
  const capAt = args.receipt.firstEntryAt + SKILL_UPDATE_RECEIPT_CAP_MS;
  if (args.now >= capAt) {
    return { seal: "cap" };
  }
  const quietAt = args.receipt.lastEntryAt + SKILL_UPDATE_RECEIPT_QUIET_MS;
  if (args.anyRunLive) {
    return {
      seal: null,
      nextCheckAt: Math.min(
        args.now + SKILL_UPDATE_RECEIPT_LIVE_RUN_RECHECK_MS,
        capAt,
      ),
    };
  }
  if (args.now >= quietAt) {
    return { seal: "quiet" };
  }
  return { seal: null, nextCheckAt: Math.min(quietAt, capAt) };
}

/**
 * Whether the run that produced an entry has finished. A fork conversation
 * that no longer exists counts as finished: superseded-fork GC deletes the
 * row, and a run cannot be processing without one. Same reading as the
 * skill card's gate.
 */
async function isRunFinished(runConversationId: string): Promise<boolean> {
  const conversation = await getConversation(runConversationId);
  if (!conversation) {
    return true;
  }
  return !(await isConversationProcessing(runConversationId));
}

/**
 * The entries whose source conversation still exists. An entry with no
 * lineage has nothing to check and stays.
 */
async function dropEntriesOfDeletedSources(
  entries: SkillUpdateReceiptEntry[],
): Promise<SkillUpdateReceiptEntry[]> {
  const sources = new Set(
    entries.flatMap((entry) =>
      entry.sourceConversationId ? [entry.sourceConversationId] : [],
    ),
  );
  const gone = new Set<string>();
  for (const source of sources) {
    if (!(await getConversation(source))) {
      gone.add(source);
    }
  }
  return entries.filter(
    (entry) =>
      !entry.sourceConversationId || !gone.has(entry.sourceConversationId),
  );
}

/**
 * Job handler for `skill_update_receipt` (registered in `job-handlers.ts`).
 * A malformed payload is dropped with a warning. A pipeline failure returns
 * `retryable` so the worker's budget covers it.
 */
export async function skillUpdateReceiptJob(
  job: MemoryJob,
): Promise<JobQueueResolution | undefined> {
  const payload = parseSkillUpdateReceiptPayload(job.payload);
  if (!payload || payload.entries.length === 0) {
    log.warn(
      { jobId: job.id },
      "skill-update receipt: dropping job with malformed or empty payload",
    );
    return undefined;
  }

  const runIds = [
    ...new Set(payload.entries.map((entry) => entry.runConversationId)),
  ];
  let anyRunLive = false;
  for (const runId of runIds) {
    if (!(await isRunFinished(runId))) {
      anyRunLive = true;
      break;
    }
  }
  const decision = decideSkillUpdateReceiptSeal({
    receipt: payload,
    anyRunLive,
    now: Date.now(),
  });
  if (decision.seal === null) {
    // Not settled. The claimed row completes and the payload moves to a
    // pending row for the next check, merging with any entries that landed
    // meanwhile.
    upsertSkillUpdateReceiptJob(payload, decision.nextCheckAt);
    return undefined;
  }

  if (hasPendingJobOfType("skill_update_receipt")) {
    // An entry landed while this row was being evaluated and opened a
    // sibling. The sibling carries the burst: merge into it and announce
    // nothing, so the two rows do not become two bell rows.
    upsertSkillUpdateReceiptJob(payload, Date.now());
    log.info(
      { jobId: job.id, entryCount: payload.entries.length },
      "skill-update receipt: merged into the sibling that opened during evaluation",
    );
    return undefined;
  }

  // The claimed payload is a snapshot: a source conversation deleted while
  // this row was evaluated was purged from pending rows only. Announce
  // nothing distilled from a conversation that is gone.
  const entries = await dropEntriesOfDeletedSources(payload.entries);
  if (entries.length === 0) {
    log.info(
      { jobId: job.id },
      "skill-update receipt: every entry's source conversation was deleted; nothing to announce",
    );
    return undefined;
  }

  const { title, body } = composeSkillUpdateReceiptCopy(entries);
  const skillIds = new Set(entries.map((entry) => entry.skillId));
  const [onlySkillId] = skillIds;
  const result = await emitNotificationSignal({
    // A tool's work reported after the fact, not the scheduler's:
    // `home-feed-side-effect` derives `fromAssistant` from the channel.
    sourceChannel: "assistant_tool",
    sourceContextId: skillUpdateReceiptSourceContextId(job.id, entries),
    sourceEventName: "activity.complete",
    dedupeKey: skillUpdateReceiptDedupeKey(job.id),
    contextPayload: {
      summary: body,
      title,
      body,
      // The typed list the receipt panel renders; the feed maps it onto the
      // item and strips it from the free-form metadata.
      updates: entries.map((entry) => ({
        skillId: entry.skillId,
        name: entry.name,
        summary: entry.changeSummary,
        ...(entry.sourceConversationId
          ? { conversationId: entry.sourceConversationId }
          : {}),
      })),
      // A receipt naming one skill links to it from the detail's footer the
      // way a single-skill notification does.
      ...(skillIds.size === 1 && onlySkillId ? { skillId: onlySkillId } : {}),
    },
    attentionHints: {
      requiresAction: false,
      urgency: "low",
      isAsyncBackground: true,
      visibleInSourceNow: false,
    },
  });
  if (result.pipelineFailed) {
    return {
      queueResolution: "retryable",
      errorMessage: `skill-update receipt announcement failed: ${result.reason}`,
    };
  }
  log.info(
    {
      jobId: job.id,
      sealedBy: decision.seal,
      entryCount: entries.length,
      skillCount: skillIds.size,
      deduplicated: result.deduplicated,
      dispatched: result.dispatched,
    },
    "skill-update receipt announced",
  );
  return undefined;
}
