// ---------------------------------------------------------------------------
// Memory retrospective — skill-authored card insertion.
// ---------------------------------------------------------------------------
//
// When a retrospective run authors NEW managed skills (successful
// `scaffold_managed_skill` calls without `overwrite: true`), the finalize
// path surfaces them to the user as a single `skill_card` ui_surface message
// appended to the SOURCE conversation. The ui_surface block is rendered by
// the web client's surface router and is paired with a `_surfaceFallback`
// text block (the approval-card pattern) so providers that drop `ui_surface`
// blocks still send a non-empty assistant turn and flat-text consumers (CLI,
// search, channel replies) see readable content.
//
// A source conversation that is MID-TURN never gets the card inserted
// directly — incremental checkpoint persistence writes tool turns to the DB
// while the agent loop is still running, so a card row could land between a
// persisted `tool_use` and its later `tool_result`. Providers that translate
// history linearly (the OpenAI-compatible chat-completions provider) would
// then emit `assistant(tool_calls) → assistant(text) → tool(...)`, and strict
// backends reject `tool` messages that don't directly follow their
// `tool_calls` message — wedging the conversation. Instead, the insert is
// DEFERRED via a durable `skill_card_insert` job that re-checks on a short
// cadence and re-upserts itself until the turn ends, so the card is still
// always delivered (queue-until-turn-end).
//
// The finalize entry point (`insertSkillCardMessage`) is best-effort: a card
// failure must never fail the retrospective job. Once queued, the job handler
// (`skillCardInsertJob`) lets persistence errors propagate so the jobs
// worker's retry machinery covers transient failures.

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
import { loadRetrospectiveRunMessages } from "./memory-retrospective-fork-boundary.js";

const log = getLogger("memory-retrospective-skill-card");

/**
 * Assistant feature flag gating skill-card insertion (default off; declared
 * in the feature-flag registry with `scope: "both"` — the web client gates
 * rendering on the same key).
 */
export const SKILL_CREATION_CARD_FLAG = "skill-creation-card";

/** A newly created skill extracted from a retrospective run's fork tail. */
export interface AuthoredSkill {
  skillId: string;
  name: string;
  description: string;
  emoji?: string;
}

/**
 * Pull the newly created skills out of a retrospective run's own work.
 * Mirrors `extractRetrospectiveRunRemembers`: the run conversation's
 * `source` kind is resolved internally, and `loadRetrospectiveRunMessages`
 * scopes fork-kind rows to the post-fork tail (the copied prefix contains
 * the source conversation's own inline tool calls) and returns `null` on
 * load failure or an undetectable fork boundary — treated here as "the run
 * authored nothing".
 *
 * A `scaffold_managed_skill` call counts only when it is a CREATE
 * (`input.overwrite !== true` — refinements never get a card) and its paired
 * `tool_result` (matched by `tool_use_id` in a later user-role message)
 * exists and is not an error. Robust to malformed content JSON — unparseable
 * rows are skipped, not propagated.
 */
export async function extractRetrospectiveRunSkillScaffolds(
  retrospectiveConversationId: string,
): Promise<AuthoredSkill[]> {
  const runMessages = await loadRetrospectiveRunMessages(
    retrospectiveConversationId,
    (await getConversation(retrospectiveConversationId))?.source ?? null,
  );
  if (runMessages == null) {
    return [];
  }
  return extractSuccessfulScaffolds(runMessages);
}

interface MessageLike {
  role: string;
  content: string;
}

function parseBlocks(msg: MessageLike): Array<Record<string, unknown>> {
  let blocks: unknown;
  try {
    blocks = JSON.parse(msg.content);
  } catch {
    return [];
  }
  if (!Array.isArray(blocks)) {
    return [];
  }
  return blocks.filter(
    (b): b is Record<string, unknown> => !!b && typeof b === "object",
  );
}

/**
 * Single ordered pass: assistant-role `scaffold_managed_skill` tool_use
 * blocks become pending candidates keyed by tool_use id; a later user-role
 * `tool_result` with a matching `tool_use_id` resolves the candidate —
 * success promotes it to the result list, an error discards it. Candidates
 * whose result never arrives (interrupted run) are not verifiably created
 * and are dropped.
 */
function extractSuccessfulScaffolds(messages: MessageLike[]): AuthoredSkill[] {
  const pending = new Map<string, AuthoredSkill>();
  const authored: AuthoredSkill[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const b of parseBlocks(msg)) {
        if (b.type !== "tool_use" || b.name !== "scaffold_managed_skill") {
          continue;
        }
        if (typeof b.id !== "string") {
          continue;
        }
        const skill = readScaffoldInput(b.input);
        if (skill) {
          pending.set(b.id, skill);
        }
      }
    } else if (msg.role === "user") {
      for (const b of parseBlocks(msg)) {
        // guard:allow-tool-result-only — only the local tool executor's
        // `tool_result` can resolve a `scaffold_managed_skill` candidate; a
        // `web_search_tool_result` pairs a `server_tool_use`, never a scaffold
        // call, so it can never match a pending id and is correctly skipped.
        if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") {
          continue;
        }
        const skill = pending.get(b.tool_use_id);
        if (!skill) {
          continue;
        }
        pending.delete(b.tool_use_id);
        if (b.is_error !== true) {
          authored.push(skill);
        }
      }
    }
  }
  return authored;
}

/**
 * Mirror of the scaffold executor's frontmatter normalization (collapse
 * embedded newlines to a space, trim). Kept local because the executor's
 * `sanitizeFrontmatterValue` is not exported; the two must stay in step so
 * the card shows the values as persisted.
 */
function normalizeCardText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Read a card entry from a `scaffold_managed_skill` tool_use input. Returns
 * `null` for refinements (`overwrite: true`) and for inputs missing a usable
 * `skill_id`/`name` (the web card drops entries without both, so there is
 * nothing to render).
 *
 * Values are NORMALIZED, not stored raw: `executeScaffoldManagedSkill` trims
 * `skill_id` (and newline-collapses + trims name/description/emoji) before
 * persisting, so a successful call with a padded `" my-skill "` creates skill
 * `my-skill` — a card built from the raw input would link `%20my-skill%20`
 * and the detail route would 404 on the skill it just announced.
 */
function readScaffoldInput(input: unknown): AuthoredSkill | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const rec = input as Record<string, unknown>;
  if (rec.overwrite === true) {
    return null;
  }
  const skillId = typeof rec.skill_id === "string" ? rec.skill_id.trim() : "";
  const name = typeof rec.name === "string" ? normalizeCardText(rec.name) : "";
  if (skillId.length === 0 || name.length === 0) {
    return null;
  }
  const description =
    typeof rec.description === "string"
      ? normalizeCardText(rec.description)
      : "";
  const emoji =
    typeof rec.emoji === "string" ? normalizeCardText(rec.emoji) : "";
  return {
    skillId,
    name,
    description,
    ...(emoji.length > 0 ? { emoji } : {}),
  };
}

/**
 * Delay before a deferred `skill_card_insert` job (re-)checks the source
 * conversation's turn state. Each still-mid-turn attempt re-upserts itself at
 * this cadence, so the loop self-resolves as soon as the turn ends; there is
 * no attempt cap because the exit conditions (turn ended → insert, source
 * deleted → drop) are guaranteed to be reached.
 */
export const SKILL_CARD_INSERT_RETRY_DELAY_MS = 30_000;

/**
 * Insert the skill card into the source conversation — or, when the source is
 * mid-turn, queue a durable `skill_card_insert` job so the card lands after
 * the turn ends (see the module header for why a mid-turn insert must never
 * happen). Delivery is guaranteed once queued; a card is never dropped except
 * when the source conversation itself no longer exists.
 *
 * This finalize entry point is best-effort — failures (insert AND enqueue)
 * are logged and never thrown, so a card failure never fails the
 * retrospective job.
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
 * Payload of a deferred `skill_card_insert` job. The authored-skill list is
 * snapshotted at enqueue time: the run conversation may be GC'd as a
 * superseded prior before the job fires, so the handler must not re-extract
 * from it.
 */
interface SkillCardInsertJobPayload {
  sourceConversationId: string;
  runConversationId: string;
  skills: AuthoredSkill[];
}

/**
 * Job handler for `skill_card_insert` (registered in `job-handlers.ts`): the
 * deferred half of {@link insertSkillCardMessage}. Re-checks the source
 * conversation — deleted → drop with a log; still mid-turn → re-upsert itself
 * at {@link SKILL_CARD_INSERT_RETRY_DELAY_MS} (the currently claimed row is
 * `running`, so the upsert creates a fresh pending row and the attempt
 * counter never accumulates); idle → insert. A malformed payload is dropped
 * with a warning. Unlike the finalize entry point, persistence errors
 * PROPAGATE so the jobs worker's standard retry-with-backoff covers transient
 * failures; a retried insert after a success is deduplicated by
 * `clientMessageId`.
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
 * {@link skillCardInsertJob}. When the source is idle, appends the
 * `skill_card` ui_surface message (plus its `_surfaceFallback` text sibling)
 * and notifies connected clients. The `surfaceId` (doubling as the insert's
 * idempotency nonce via `clientMessageId`) is derived from the run
 * conversation id, so a retried delivery cannot produce two cards for one
 * run — a deduplicated insert also skips the disk-view sync and client
 * broadcast. Distinct runs get distinct ids, so a conversation accumulates
 * one card per authoring run over its life, by design.
 *
 * The retrospective accounting excludes `SKILL_CARD_MESSAGE_KIND` rows from
 * re-trigger counting, so a delivered card never wakes another pass. Errors
 * propagate to the caller — the finalize entry point swallows them, the job
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
