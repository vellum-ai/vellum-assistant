// ---------------------------------------------------------------------------
// Memory retrospective — skill-authored card delivery.
// ---------------------------------------------------------------------------
//
// When a retrospective pass genuinely CREATES a managed skill, the scaffold
// executor (`executeScaffoldManagedSkill`) enqueues a durable
// `skill_card_insert` job at the creation site — the executor knows
// created-vs-overwrote, the request origin, and the fork-parent source
// conversation as facts, so no message archaeology is needed. This module
// owns the DELIVERY half of that flow: the job handler surfaces the authored
// skills to the user as a single `skill_card` ui_surface message appended to
// the SOURCE conversation. The ui_surface block is rendered by the web
// client's surface router and is paired with a `_surfaceFallback` text block
// (the approval-card pattern) so providers that drop `ui_surface` blocks
// still send a non-empty assistant turn and flat-text consumers (CLI, search,
// channel replies) see readable content.
//
// Enqueues fire at the creation site — one per scaffold call, DURING the
// retrospective fork run — and the jobs-store upsert coalesces them by run
// conversation id into a single pending row. Delivery therefore defers while
// the RUN conversation is still processing: the source conversation is
// usually idle mid-run, so without this gate the worker could deliver skill
// A's card before skill B's enqueue lands, and B's job would then dedup
// against the inserted message (`clientMessageId` is run-derived) and never
// appear on any card. Holding delivery until the run finishes guarantees
// every creation from that run has merged into the pending row first — the
// card is always complete. A run conversation that no longer exists
// (superseded-fork GC) counts as finished: a fork can't be processing once
// its row is gone, and the card must still deliver.
//
// A source conversation that is MID-TURN never gets the card inserted
// directly — incremental checkpoint persistence writes tool turns to the DB
// while the agent loop is still running, so a card row could land between a
// persisted `tool_use` and its later `tool_result`. Providers that translate
// history linearly (the OpenAI-compatible chat-completions provider) would
// then emit `assistant(tool_calls) → assistant(text) → tool(...)`, and strict
// backends reject `tool` messages that don't directly follow their
// `tool_calls` message — wedging the conversation. A deferred delivery
// attempt (run still processing OR source mid-turn) re-upserts the job on a
// short cadence until both gates clear, so the card is still always
// delivered (queue-until-run-and-turn-end).
//
// The job handler (`skillCardInsertJob`) lets persistence errors propagate so
// the jobs worker's retry machinery covers transient failures; the
// message-level `clientMessageId` dedup makes retried deliveries idempotent.

import {
  addMessage,
  getConversation,
  isConversationProcessing,
  syncMessageToDisk,
} from "@vellumai/plugin-api";

import {
  type MemoryJob,
  upsertSkillCardInsertJob,
} from "../../../persistence/jobs-store.js";
import { publishConversationMessagesChanged } from "../../../runtime/sync/resource-sync-events.js";
import { getLogger } from "./logging.js";
import { SKILL_CARD_MESSAGE_KIND } from "./memory-retrospective-constants.js";

const log = getLogger("memory-retrospective-skill-card");

/**
 * A skill authored by a retrospective run, as recorded by the scaffold
 * executor at creation time. All values are the executor's post-normalization
 * (trimmed, newline-collapsed) values — exactly what was persisted to the
 * skill's frontmatter — so the card always links and labels the skill as it
 * exists on disk.
 */
export interface AuthoredSkill {
  skillId: string;
  name: string;
  description: string;
  emoji?: string;
}

/**
 * Delay before a deferred `skill_card_insert` job (re-)checks its delivery
 * gates (run conversation finished, source conversation idle). Each deferred
 * attempt re-upserts itself at this cadence, so the loop self-resolves as
 * soon as the gates clear; there is no attempt cap because the exit
 * conditions (run finished/GC'd and turn ended → insert, source deleted →
 * drop) are guaranteed to be reached.
 */
export const SKILL_CARD_INSERT_RETRY_DELAY_MS = 30_000;

/**
 * Best-effort insert-or-defer entry point: insert the skill card into the
 * source conversation — or, when the run is still processing or the source
 * is mid-turn, queue a durable `skill_card_insert` job so the card lands
 * after both gates clear (see the module header for why an early insert must
 * never happen). Failures (insert AND enqueue) are logged and never thrown,
 * so a card problem never fails the caller.
 */
export async function insertSkillCardMessage(
  sourceConversationId: string,
  runConversationId: string,
  skills: AuthoredSkill[],
): Promise<void> {
  try {
    await insertOrDeferSkillCard(
      sourceConversationId,
      runConversationId,
      skills,
    );
  } catch (err) {
    log.warn(
      { err, sourceConversationId, runConversationId },
      "skill card: failed to insert skill card message; continuing",
    );
  }
}

/**
 * Payload of a `skill_card_insert` job. The authored-skill list is recorded
 * by the scaffold executor at creation time and is self-contained: the run
 * conversation may be GC'd as a superseded prior before the job fires, so the
 * handler must never need to read it.
 */
interface SkillCardInsertJobPayload {
  sourceConversationId: string;
  runConversationId: string;
  skills: AuthoredSkill[];
}

/**
 * Job handler for `skill_card_insert` (registered in `job-handlers.ts`): the
 * delivery of a retrospective run's authored-skill card. Re-checks the
 * delivery gates — source deleted → drop with a log; run conversation still
 * processing OR source mid-turn → re-upsert itself at
 * {@link SKILL_CARD_INSERT_RETRY_DELAY_MS} (the currently claimed row is
 * `running`, so the upsert creates a fresh pending row that later enqueues
 * from the same run merge into, and the attempt counter never accumulates);
 * run finished (or GC'd) and source idle → insert. A malformed payload is
 * dropped with a warning. Persistence errors PROPAGATE so the jobs worker's
 * standard retry-with-backoff covers transient failures; a retried insert
 * after a success is deduplicated by `clientMessageId`.
 */
export async function skillCardInsertJob(job: MemoryJob): Promise<void> {
  const payload = parseSkillCardInsertPayload(job.payload);
  if (!payload) {
    log.warn(
      { jobId: job.id },
      "skill card: dropping skill_card_insert job with malformed payload",
    );
    return;
  }
  await insertOrDeferSkillCard(
    payload.sourceConversationId,
    payload.runConversationId,
    payload.skills,
  );
}

/**
 * Validate a `skill_card_insert` job payload back into its typed shape.
 * Returns `null` when the ids are missing or the skill list has no
 * well-formed entry — enqueues always write the full shape, so a miss here
 * means a corrupted or foreign row that must drop rather than throw (a retry
 * cannot fix it).
 */
function parseSkillCardInsertPayload(
  payload: Record<string, unknown>,
): SkillCardInsertJobPayload | null {
  const { sourceConversationId, runConversationId } = payload;
  if (
    typeof sourceConversationId !== "string" ||
    sourceConversationId.length === 0 ||
    typeof runConversationId !== "string" ||
    runConversationId.length === 0 ||
    !Array.isArray(payload.skills)
  ) {
    return null;
  }
  const skills: AuthoredSkill[] = [];
  for (const entry of payload.skills) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const rec = entry as Record<string, unknown>;
    if (typeof rec.skillId !== "string" || rec.skillId.length === 0) {
      continue;
    }
    if (typeof rec.name !== "string" || rec.name.length === 0) {
      continue;
    }
    skills.push({
      skillId: rec.skillId,
      name: rec.name,
      description: typeof rec.description === "string" ? rec.description : "",
      ...(typeof rec.emoji === "string" && rec.emoji.length > 0
        ? { emoji: rec.emoji }
        : {}),
    });
  }
  if (skills.length === 0) {
    return null;
  }
  return { sourceConversationId, runConversationId, skills };
}

/**
 * Shared insert-or-defer core behind both {@link insertSkillCardMessage} and
 * {@link skillCardInsertJob}. When the run conversation has finished (or was
 * GC'd) and the source is idle, appends the `skill_card` ui_surface message
 * (plus its `_surfaceFallback` text sibling) and notifies connected clients. The `surfaceId` (doubling as the insert's
 * idempotency nonce via `clientMessageId`) is derived from the run
 * conversation id, so a retried delivery cannot produce two cards for one
 * run — a deduplicated insert also skips the disk-view sync and client
 * broadcast. Distinct runs get distinct ids, so a conversation accumulates
 * one card per authoring run over its life, by design.
 *
 * The retrospective accounting excludes `SKILL_CARD_MESSAGE_KIND` rows from
 * re-trigger counting, so a delivered card never wakes another pass. Errors
 * propagate to the caller — `insertSkillCardMessage` swallows them, the job
 * handler surfaces them to the worker's retry machinery.
 */
async function insertOrDeferSkillCard(
  sourceConversationId: string,
  runConversationId: string,
  skills: AuthoredSkill[],
): Promise<void> {
  const sourceConversation = await getConversation(sourceConversationId);
  if (!sourceConversation) {
    log.info(
      { sourceConversationId, runConversationId },
      "skill card: source conversation no longer exists; skipping",
    );
    return;
  }
  // Run still processing: defer rather than insert. Enqueues fire per
  // scaffold call DURING the fork run, and the jobs-store upsert coalesces
  // them by run conversation id — delivering before the run finishes could
  // let a later creation from the same run dedup against this insert's
  // run-derived `clientMessageId` and never appear on any card (see module
  // header). A missing run conversation counts as finished: superseded-fork
  // GC deletes the row, and a fork can't be processing without one, so the
  // card must still deliver. (`isConversationProcessing` already reads
  // `false` for a nonexistent id; the explicit existence check pins that
  // missing-row-wins semantics against its in-memory fast path.)
  const runConversation = await getConversation(runConversationId);
  if (runConversation && (await isConversationProcessing(runConversationId))) {
    upsertSkillCardInsertJob(
      { sourceConversationId, runConversationId, skills },
      Date.now() + SKILL_CARD_INSERT_RETRY_DELAY_MS,
    );
    log.info(
      {
        sourceConversationId,
        runConversationId,
        retryDelayMs: SKILL_CARD_INSERT_RETRY_DELAY_MS,
      },
      "skill card: run conversation is still processing; deferred via skill_card_insert job",
    );
    return;
  }
  // Mid-turn: defer rather than insert. Incremental checkpoint persistence
  // means a card row could otherwise land between a persisted `tool_use` and
  // its later `tool_result` — a history that linear-translation providers
  // render in an order strict OpenAI-compatible backends reject (see module
  // header). The durable job re-checks until the turn ends, so the card
  // still always arrives.
  if (await isConversationProcessing(sourceConversationId)) {
    upsertSkillCardInsertJob(
      { sourceConversationId, runConversationId, skills },
      Date.now() + SKILL_CARD_INSERT_RETRY_DELAY_MS,
    );
    log.info(
      {
        sourceConversationId,
        runConversationId,
        retryDelayMs: SKILL_CARD_INSERT_RETRY_DELAY_MS,
      },
      "skill card: source conversation is mid-turn; deferred via skill_card_insert job",
    );
    return;
  }
  const surfaceId = `skill-card-${runConversationId}`;
  const surfaceBlock = {
    type: "ui_surface",
    surfaceId,
    surfaceType: "skill_card",
    title: "New skill learned",
    display: "inline",
    data: {
      skills: skills.map((s) => ({
        skillId: s.skillId,
        name: s.name,
        description: s.description,
        emoji: s.emoji ?? null,
      })),
    },
  };
  // Plain-text fallback (approval-card pattern): feeds the model, search,
  // CLI display, and channel replies. Surface-capable clients skip it —
  // `renderHistoryContent` keeps `_surfaceFallback` text out of the
  // rendered content blocks so the card is never double-rendered.
  const fallbackBlock = {
    type: "text",
    text: `New skill learned: ${skills.map((s) => s.name).join(", ")}`,
    _surfaceFallback: true,
  };
  const persisted = await addMessage(
    sourceConversationId,
    "assistant",
    JSON.stringify([surfaceBlock, fallbackBlock]),
    {
      metadata: { kind: SKILL_CARD_MESSAGE_KIND, automated: true },
      skipIndexing: true,
      clientMessageId: surfaceId,
    },
  );
  if (persisted.deduplicated) {
    log.info(
      { sourceConversationId, runConversationId, surfaceId },
      "skill card: message already exists (deduplicated); skipping sync and publish",
    );
    return;
  }
  // Mirror `persistWakeTriggerMessage`: keep the conversation's disk view
  // in sync (its own failure is non-fatal so the client broadcast below
  // still fires), then tell connected clients the message list changed.
  try {
    await syncMessageToDisk(
      sourceConversationId,
      persisted.id,
      sourceConversation.createdAt,
    );
  } catch (err) {
    log.warn(
      { err, sourceConversationId },
      "skill card: syncMessageToDisk failed (non-fatal)",
    );
  }
  publishConversationMessagesChanged(sourceConversationId);
  log.info(
    {
      sourceConversationId,
      runConversationId,
      surfaceId,
      skillIds: skills.map((s) => s.skillId),
    },
    "skill card: inserted into source conversation",
  );
}
