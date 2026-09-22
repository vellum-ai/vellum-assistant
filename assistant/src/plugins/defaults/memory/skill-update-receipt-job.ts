// ---------------------------------------------------------------------------
// Skill-update receipts: the tick job.
// ---------------------------------------------------------------------------
//
// `skill_update_receipt_tick` is a stateless job: it reads the receipt
// tables (`skill-update-receipt-store.ts`), does whatever is due, and
// enqueues the next tick if anything is still open. Losing or failing a
// tick loses nothing, since the entries and the receipt's state are in the
// tables; the worker's idle branch and its startup both enqueue a tick
// whenever a receipt is open or sealed and none is pending.
//
// A tick does two things, sealed receipts first so a receipt that closed on
// the previous tick is announced before the open one is examined:
//
//   Deliver. Each sealed receipt is announced once through
//   `emitNotificationSignal`, the single entry point every notification
//   producer uses, under a dedupe key naming the receipt. The pipeline
//   decides whether and where the announcement goes; this job never writes
//   the home feed and never releases the key. The receipt's terminal state
//   is read off what the pipeline did: a row in the home feed means it was
//   delivered, a normal return with no row means the pipeline declined
//   (`settled_no_row`) unless it dispatched and its own feed write failed
//   (`undelivered`), a failed pipeline is retried on the next tick within
//   a bounded number of attempts, and a `deduplicated` return with no row
//   (a crash after the event row landed, before the feed write) is
//   `undelivered`, because nothing this job can read distinguishes a crash
//   before the verdict from a verdict it must not appeal.
//
//   Seal. The open receipt is sealed once the burst has settled: every run
//   that contributed an entry has finished (its fork conversation is no
//   longer processing, or is gone), and no entry has arrived for the quiet
//   window. A burst that never goes quiet is sealed at the cap, measured
//   from its first entry. The seal is a compare-and-set on the revision the
//   evaluation read, so an entry that lands during evaluation keeps the
//   receipt open and the next tick counts it (see the store's invariants).
//
// The window and the cap are instrumented defaults, not settled numbers:
// each delivery records a watchdog event with the receipt's shape, and the
// two constants are tuned from that series.

import {
  getConversation,
  isConversationProcessing,
} from "@vellumai/plugin-api";

import { feedItemIdForSignal } from "../../../home/feed-types.js";
import { readHomeFeed } from "../../../home/feed-writer.js";
import { emitNotificationSignal } from "../../../notifications/emit-signal.js";
import { findEventIdByDedupeKey } from "../../../notifications/events-store.js";
import {
  enqueueMemoryJob,
  hasActiveJobOfType,
  hasPendingJobOfType,
  type MemoryJob,
} from "../../../persistence/jobs-store.js";
import { recordWatchdogEvent } from "../../../telemetry/watchdog-events-store.js";
import { getLogger } from "./logging.js";
import {
  countSkillUpdateReceiptEmitAttempt,
  hasUnsettledSkillUpdateReceipt,
  listSealedSkillUpdateReceipts,
  listSkillUpdateReceiptEntries,
  readOpenSkillUpdateReceipt,
  readSkillUpdateReceipt,
  sealSkillUpdateReceipt,
  settleSkillUpdateReceipt,
  type SkillUpdateReceipt,
  type SkillUpdateReceiptEntry,
  type SkillUpdateReceiptSealedBy,
} from "./skill-update-receipt-store.js";

const log = getLogger("skill-update-receipt-job");

/**
 * How long a receipt stays open after its last entry before it is sealed.
 * Equal to the retrospective's default interval trigger, so runs a
 * conversation's message count keeps triggering (at most every five
 * minutes) chain into one receipt, while interval-driven runs of a slow
 * conversation each get their own.
 */
export const SKILL_UPDATE_RECEIPT_QUIET_MS = 30 * 60 * 1000;

/**
 * The longest a receipt stays open, measured from its first entry. A burst
 * that never goes quiet is announced at the cap and a later entry opens the
 * next receipt.
 */
export const SKILL_UPDATE_RECEIPT_CAP_MS = 2 * 60 * 60 * 1000;

/**
 * How soon a tick re-checks a receipt whose contributing run is still live.
 * The run's end is what the tick is waiting for, and a run is a single wake,
 * so a short cadence catches it without polling hard.
 */
export const SKILL_UPDATE_RECEIPT_LIVE_RUN_RECHECK_MS = 30_000;

/**
 * How many times a sealed receipt is announced before it is given up as
 * `undelivered`. Each attempt is counted before the emit, so a crash between
 * the emit and the outcome being recorded still spends one.
 */
export const SKILL_UPDATE_RECEIPT_MAX_EMIT_ATTEMPTS = 3;

/**
 * How long after a failed announcement the next attempt waits. The pipeline
 * failed on its own machinery (the database, the decision call), and an
 * immediate retry mostly meets the same fault.
 */
export const SKILL_UPDATE_RECEIPT_EMIT_RETRY_MS = 5 * 60 * 1000;

/** Watchdog check_name of the per-delivery shape event. */
const RECEIPT_SETTLED_CHECK_NAME = "skill_update_receipt_settled";

/** The dedupe key a receipt is announced under. */
export function skillUpdateReceiptDedupeKey(receiptId: string): string {
  return `skill-update-receipt:${receiptId}`;
}

/**
 * The `sourceContextId` a receipt is announced with. The home feed's
 * "Go to Conversation" and the vellum delivery's body append both resolve
 * this to a conversation, so a receipt whose rewrites all came from one
 * conversation names it; one spanning several passes a sentinel that
 * resolves to nothing, and the receipt's own entries carry the links.
 */
export function skillUpdateReceiptSourceContextId(
  receiptId: string,
  entries: SkillUpdateReceiptEntry[],
): string {
  const sources = new Set(
    entries.flatMap((entry) =>
      entry.sourceConversationId ? [entry.sourceConversationId] : [],
    ),
  );
  if (sources.size === 1) {
    const [only] = sources;
    if (only) {
      return only;
    }
  }
  return `skill-update-receipt:${receiptId}`;
}

/**
 * The English fallback title and body, for a delivery surface that renders
 * the item as it arrived: a bundle without the receipt panel, a channel
 * post, a banner. The web client derives its own title from the entries.
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

/**
 * Enqueue a tick unless one is already pending. Called by the producer after
 * an append, by the worker's idle branch and startup as the backstop, and by
 * a tick that leaves a receipt open. Best-effort: a failed enqueue is logged
 * and the backstop tries again.
 */
export function enqueueSkillUpdateReceiptTick(
  runAfter: number = Date.now(),
): void {
  try {
    if (hasPendingJobOfType("skill_update_receipt_tick")) {
      return;
    }
    enqueueMemoryJob("skill_update_receipt_tick", {}, runAfter);
  } catch (err) {
    log.warn({ err }, "failed to enqueue the skill-update receipt tick");
  }
}

/**
 * The worker's backstop: enqueue a tick when a receipt is open or sealed and
 * no tick is pending, so a tick lost to a crash, a failed row, or an older
 * worker that did not know the job type is replaced.
 */
export function maybeEnqueueSkillUpdateReceiptTick(): void {
  try {
    if (
      hasUnsettledSkillUpdateReceipt() &&
      !hasActiveJobOfType("skill_update_receipt_tick")
    ) {
      enqueueSkillUpdateReceiptTick();
    }
  } catch (err) {
    log.warn({ err }, "skill-update receipt backstop failed");
  }
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

export type SkillUpdateReceiptSealDecision =
  | { seal: SkillUpdateReceiptSealedBy; withRev: boolean }
  | { seal: null; nextCheckAt: number };

/**
 * Whether the open receipt is due to be sealed, and if not, when to look
 * again. Pure, so the boundary can be asserted without a clock or a store.
 */
export function decideSkillUpdateReceiptSeal(args: {
  receipt: Pick<SkillUpdateReceipt, "firstEntryAt" | "lastEntryAt">;
  anyRunLive: boolean;
  now: number;
  quietMs?: number;
  capMs?: number;
  liveRunRecheckMs?: number;
}): SkillUpdateReceiptSealDecision {
  const quietMs = args.quietMs ?? SKILL_UPDATE_RECEIPT_QUIET_MS;
  const capMs = args.capMs ?? SKILL_UPDATE_RECEIPT_CAP_MS;
  const recheckMs =
    args.liveRunRecheckMs ?? SKILL_UPDATE_RECEIPT_LIVE_RUN_RECHECK_MS;
  const capAt = args.receipt.firstEntryAt + capMs;
  if (args.now >= capAt) {
    // The cap seals whatever the receipt holds, so it ignores the revision:
    // an entry landing during evaluation belongs to the next receipt.
    return { seal: "cap", withRev: false };
  }
  const quietAt = args.receipt.lastEntryAt + quietMs;
  if (args.anyRunLive) {
    return { seal: null, nextCheckAt: Math.min(args.now + recheckMs, capAt) };
  }
  if (args.now >= quietAt) {
    return { seal: "quiet", withRev: true };
  }
  return { seal: null, nextCheckAt: Math.min(quietAt, capAt) };
}

/** Whether the pipeline wrote the home-feed row for `eventId`. */
function hasFeedRow(eventId: string): boolean {
  const id = feedItemIdForSignal(eventId);
  return readHomeFeed().items.some((item) => item.id === id);
}

type TerminalStatus = "delivered" | "settled_no_row" | "undelivered";

/**
 * Announce one sealed receipt and settle it from what the pipeline did.
 * Returns the terminal state reached, or null when the receipt stays sealed
 * for another attempt.
 */
async function deliverSealedReceipt(
  receipt: SkillUpdateReceipt,
): Promise<TerminalStatus | null> {
  const entries = listSkillUpdateReceiptEntries(receipt.id);
  const dedupeKey = skillUpdateReceiptDedupeKey(receipt.id);
  if (entries.length === 0) {
    // Nothing to announce. A receipt is only created by an append, so this
    // is a receipt whose entries were lost; settle it rather than announce
    // an empty list.
    settle(receipt, entries, "settled_no_row", "no entries");
    return "settled_no_row";
  }

  const attempts = countSkillUpdateReceiptEmitAttempt(receipt.id);
  receipt = { ...receipt, emitAttempts: attempts };
  if (attempts > SKILL_UPDATE_RECEIPT_MAX_EMIT_ATTEMPTS) {
    settle(receipt, entries, "undelivered", "emit attempts exhausted");
    return "undelivered";
  }

  const { title, body } = composeSkillUpdateReceiptCopy(entries);
  const skillIds = new Set(entries.map((entry) => entry.skillId));
  const sourceContextId = skillUpdateReceiptSourceContextId(
    receipt.id,
    entries,
  );
  const [onlySkillId] = skillIds;
  const result = await emitNotificationSignal({
    // This emit is a tool's work reported after the fact, not the
    // scheduler's: `home-feed-side-effect` derives `fromAssistant` from the
    // channel, and the feed's assistant-initiated filter reads it.
    sourceChannel: "assistant_tool",
    sourceContextId,
    sourceEventName: "activity.complete",
    dedupeKey,
    contextPayload: {
      summary: body,
      title,
      body,
      // The typed list the receipt panel renders. The feed maps it onto the
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
    log.warn(
      { receiptId: receipt.id, attempts, reason: result.reason },
      "skill-update receipt announcement failed; retrying on the next tick",
    );
    return null;
  }
  if (result.deduplicated) {
    // An earlier attempt's event row holds the key. If that attempt reached
    // the feed the receipt was delivered; otherwise nothing here can tell a
    // crash before the verdict from a verdict this job must not appeal.
    const eventId = findEventIdByDedupeKey(dedupeKey);
    if (eventId && hasFeedRow(eventId)) {
      settle(receipt, entries, "delivered");
      return "delivered";
    }
    settle(receipt, entries, "undelivered", "interrupted");
    return "undelivered";
  }
  if (hasFeedRow(result.signalId)) {
    settle(receipt, entries, "delivered");
    return "delivered";
  }
  // The feed writer swallows its own write errors, so a dispatched
  // announcement with no row is a failed feed write, not a verdict. A retry
  // would only meet the dedupe key, so it settles as undelivered and is
  // counted. A pipeline that never dispatched declined the row on purpose.
  if (result.dispatched) {
    settle(receipt, entries, "undelivered", "feed write failed");
    return "undelivered";
  }
  settle(receipt, entries, "settled_no_row", result.reason);
  return "settled_no_row";
}

function settle(
  receipt: SkillUpdateReceipt,
  entries: SkillUpdateReceiptEntry[],
  status: TerminalStatus,
  reason?: string,
): void {
  const now = Date.now();
  settleSkillUpdateReceipt({ id: receipt.id, status, reason, now });
  const gaps = entries
    .slice(1)
    .map((entry, index) => entry.createdAt - (entries[index]?.createdAt ?? 0));
  try {
    recordWatchdogEvent({
      checkName: RECEIPT_SETTLED_CHECK_NAME,
      value: entries.length,
      detail: {
        terminal_state: status,
        sealed_by: receipt.sealedBy,
        entry_count: entries.length,
        distinct_skill_count: new Set(entries.map((e) => e.skillId)).size,
        distinct_source_count: new Set(
          entries.flatMap((e) =>
            e.sourceConversationId ? [e.sourceConversationId] : [],
          ),
        ).size,
        distinct_run_count: new Set(entries.map((e) => e.runConversationId))
          .size,
        hold_ms: (receipt.sealedAt ?? now) - receipt.firstEntryAt,
        max_gap_ms: gaps.length > 0 ? Math.max(...gaps) : 0,
        emit_attempts: receipt.emitAttempts,
      },
    });
  } catch {
    // recordWatchdogEvent already no-ops on opt-out and a missing telemetry
    // DB; anything past that is not worth surfacing here.
  }
  log.info(
    { receiptId: receipt.id, status, reason, entryCount: entries.length },
    "skill-update receipt settled",
  );
}

/**
 * Job handler for `skill_update_receipt_tick` (registered in
 * `job-handlers.ts`). Delivers every sealed receipt, then evaluates the open
 * one, sealing and delivering it in the same tick when it is due. Leaves a
 * tick queued for the next boundary if a receipt stays open. Errors
 * propagate to the worker's retry machinery; the backstop replaces a tick
 * that dead-letters.
 */
export async function skillUpdateReceiptTickJob(
  _job: MemoryJob,
): Promise<void> {
  let retryDelivery = false;
  for (const sealed of listSealedSkillUpdateReceipts()) {
    if ((await deliverSealedReceipt(sealed)) === null) {
      retryDelivery = true;
    }
  }

  const open = readOpenSkillUpdateReceipt();
  if (!open) {
    if (retryDelivery) {
      enqueueSkillUpdateReceiptTick(
        Date.now() + SKILL_UPDATE_RECEIPT_EMIT_RETRY_MS,
      );
    }
    return;
  }
  const entries = listSkillUpdateReceiptEntries(open.id);
  const runIds = [...new Set(entries.map((entry) => entry.runConversationId))];
  let anyRunLive = false;
  for (const runId of runIds) {
    if (!(await isRunFinished(runId))) {
      anyRunLive = true;
      break;
    }
  }
  const decision = decideSkillUpdateReceiptSeal({
    receipt: open,
    anyRunLive,
    now: Date.now(),
  });
  if (decision.seal === null) {
    enqueueSkillUpdateReceiptTick(
      retryDelivery
        ? Math.min(
            decision.nextCheckAt,
            Date.now() + SKILL_UPDATE_RECEIPT_EMIT_RETRY_MS,
          )
        : decision.nextCheckAt,
    );
    return;
  }
  const sealed = sealSkillUpdateReceipt({
    id: open.id,
    rev: decision.withRev ? open.rev : null,
    sealedBy: decision.seal,
  });
  if (!sealed) {
    // An entry landed during evaluation. The receipt stays open with it
    // counted; look again at the next boundary.
    enqueueSkillUpdateReceiptTick(
      Date.now() + SKILL_UPDATE_RECEIPT_LIVE_RUN_RECHECK_MS,
    );
    return;
  }
  const justSealed = readSkillUpdateReceipt(open.id);
  if (justSealed && (await deliverSealedReceipt(justSealed)) === null) {
    retryDelivery = true;
  }
  // An entry that arrived after the seal opened the next receipt, and a
  // failed announcement is owed another attempt.
  if (retryDelivery) {
    enqueueSkillUpdateReceiptTick(
      Date.now() + SKILL_UPDATE_RECEIPT_EMIT_RETRY_MS,
    );
  } else if (readOpenSkillUpdateReceipt()) {
    enqueueSkillUpdateReceiptTick(
      Date.now() + SKILL_UPDATE_RECEIPT_LIVE_RUN_RECHECK_MS,
    );
  }
}
