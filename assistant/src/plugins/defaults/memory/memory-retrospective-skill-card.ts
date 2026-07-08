// ---------------------------------------------------------------------------
// Memory retrospective — skill-authored card insertion.
// ---------------------------------------------------------------------------
//
// When a retrospective run authors NEW managed skills (successful
// `scaffold_managed_skill` calls without `overwrite: true`), the finalize
// path surfaces them to the user as a single `skill_card` ui_surface message
// appended to the SOURCE conversation. The block is rendered by the web
// client's surface router; the Anthropic provider strips `ui_surface` blocks
// during request assembly, so the card never reaches the model as renderable
// content.
//
// Everything here is best-effort: a card failure must never fail the
// retrospective job.

import {
  addMessage,
  getConversation,
} from "../../../persistence/conversation-crud.js";
import { syncMessageToDisk } from "../../../persistence/conversation-disk-view.js";
import { publishConversationMessagesChanged } from "../../../runtime/sync/resource-sync-events.js";
import { getLogger } from "../../../util/logger.js";
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
 * Mirrors `extractRetrospectiveRunRemembers`: `loadRetrospectiveRunMessages`
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
export function extractRetrospectiveRunSkillScaffolds(
  retrospectiveConversationId: string,
  source: string | null | undefined,
): AuthoredSkill[] {
  const runMessages = loadRetrospectiveRunMessages(
    retrospectiveConversationId,
    source,
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
 * Read a card entry from a `scaffold_managed_skill` tool_use input. Returns
 * `null` for refinements (`overwrite: true`) and for inputs missing a usable
 * `skill_id`/`name` (the web card drops entries without both, so there is
 * nothing to render).
 */
function readScaffoldInput(input: unknown): AuthoredSkill | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const rec = input as Record<string, unknown>;
  if (rec.overwrite === true) {
    return null;
  }
  const skillId = rec.skill_id;
  const name = rec.name;
  if (typeof skillId !== "string" || skillId.trim().length === 0) {
    return null;
  }
  if (typeof name !== "string" || name.trim().length === 0) {
    return null;
  }
  return {
    skillId,
    name,
    description: typeof rec.description === "string" ? rec.description : "",
    ...(typeof rec.emoji === "string" && rec.emoji.length > 0
      ? { emoji: rec.emoji }
      : {}),
  };
}

/**
 * Append the `skill_card` ui_surface message to the source conversation and
 * notify connected clients. The `surfaceId` (doubling as the insert's
 * idempotency nonce via `clientMessageId`) is derived from the run
 * conversation id, so a retried finalize cannot produce two cards for one
 * run. Skips when the source conversation no longer exists (deleted
 * mid-run). Best-effort — failures are logged and never thrown.
 */
export async function insertSkillCardMessage(
  sourceConversationId: string,
  runConversationId: string,
  skills: AuthoredSkill[],
): Promise<void> {
  try {
    const sourceConversation = getConversation(sourceConversationId);
    if (!sourceConversation) {
      log.debug(
        { sourceConversationId, runConversationId },
        "skill card: source conversation no longer exists; skipping",
      );
      return;
    }
    const surfaceId = `skill-card-${runConversationId}`;
    const block = {
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
    const persisted = await addMessage(
      sourceConversationId,
      "assistant",
      JSON.stringify([block]),
      {
        metadata: { kind: SKILL_CARD_MESSAGE_KIND, automated: true },
        skipIndexing: true,
        clientMessageId: surfaceId,
      },
    );
    // Mirror `persistWakeTriggerMessage`: keep the conversation's disk view
    // in sync (its own failure is non-fatal so the client broadcast below
    // still fires), then tell connected clients the message list changed.
    try {
      syncMessageToDisk(
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
  } catch (err) {
    log.warn(
      { err, sourceConversationId, runConversationId },
      "skill card: failed to insert skill card message; continuing",
    );
  }
}
