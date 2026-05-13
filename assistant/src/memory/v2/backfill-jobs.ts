// ---------------------------------------------------------------------------
// Memory v2 — Backfill job handlers
// ---------------------------------------------------------------------------
//
// Three operator-triggered backfills, all wired through the same job queue so
// they can be enqueued from the IPC route, the CLI, or recovery paths:
//
//   - `memory_v2_migrate`              — one-shot v1→v2 synthesis (PR 16).
//   - `memory_v2_reembed`              — fan out an `embed_concept_page` job
//     per concept-page slug.
//   - `memory_v2_activation_recompute` — recompute persisted activation
//     state for every conversation, no rendering. Used after consolidation
//     replaces or deletes pages that other conversations still reference.
//
// Each handler is intentionally small — heavy lifting lives in the modules
// they delegate to (`migration.ts`, `page-store.ts`, `embed-concept-page.ts`,
// `activation.ts`, `activation-store.ts`). Keeping the wrappers thin means
// the same code paths exercised by tests of those modules run unchanged when
// a backfill kicks them off.

import type { AssistantConfig } from "../../config/types.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { getMessages } from "../conversation-crud.js";
import { listConversations } from "../conversation-queries.js";
import { getDb } from "../db-connection.js";
import { enqueueEmbedConceptPageJob } from "../jobs/embed-concept-page.js";
import type { MemoryJob } from "../jobs-store.js";
import { stringifyMessageContent } from "../message-content.js";
import {
  computeOwnActivation,
  selectCandidates,
  spreadActivation,
} from "./activation.js";
import { hydrate, save } from "./activation-store.js";
import { getEdgeIndex } from "./edge-index.js";
import {
  MigrationAlreadyAppliedError,
  runMemoryV2Migration,
} from "./migration.js";
import { loadNowText } from "./now-text.js";
import { listPages } from "./page-store.js";

const log = getLogger("memory-v2-backfill");

// ---------------------------------------------------------------------------
// memory_v2_migrate — wraps runMemoryV2Migration
// ---------------------------------------------------------------------------

/**
 * Job handler: run the one-shot v1→v2 migration. Pass `{ force: true }` in the
 * payload to overwrite an existing v2 state when the sentinel is already
 * present (mirrors the CLI's `--force` flag in PR 25). Sentinel-gated re-runs
 * surface as `MigrationAlreadyAppliedError` — the worker logs and treats them
 * as a successful completion (no rethrow), so the job row clears without
 * spinning the retry/deferral counters.
 */
export async function memoryV2MigrateJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const force =
    typeof job.payload.force === "boolean" ? job.payload.force : false;

  try {
    const result = await runMemoryV2Migration({
      workspaceDir: getWorkspaceDir(),
      database: getDb(),
      force,
      config,
    });
    log.info(
      {
        pagesCreated: result.pagesCreated,
        edgesWritten: result.edgesWritten,
        embedsEnqueued: result.embedsEnqueued,
      },
      "Memory v2 migration complete",
    );
  } catch (err) {
    if (err instanceof MigrationAlreadyAppliedError) {
      log.info(
        "Memory v2 migration sentinel already present; skipping. Pass force: true to re-run.",
      );
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// memory_v2_reembed — fan out embed jobs for every concept page
// ---------------------------------------------------------------------------

/**
 * Job handler: enqueue an `embed_concept_page` job per concept-page slug.
 *
 * Returns the total number of jobs enqueued. Callers (and tests) use the
 * return value to assert progress without inspecting the job table directly.
 *
 * Note on meta files: `essentials.md` / `threads.md` / `recent.md` /
 * `buffer.md` are direct-injected into the system prompt every turn via
 * `_autoinject.md`. They are NOT enqueued for embedding here — their slugs
 * (`__essentials__` etc.) contain underscores that the concept-page slug
 * validator rejects (`[a-z0-9][a-z0-9-]*`), and they live at `memory/<name>.md`
 * rather than `memory/concepts/<name>.md`, so path resolution would also miss.
 * Embedding them would be redundant with the direct injection regardless.
 */
export async function memoryV2ReembedJob(
  _job: MemoryJob,
  _config: AssistantConfig,
): Promise<number> {
  const workspaceDir = getWorkspaceDir();
  const slugs = await listPages(workspaceDir);

  for (const slug of slugs) {
    enqueueEmbedConceptPageJob({ slug });
  }

  log.info(
    { conceptPages: slugs.length, total: slugs.length },
    "Memory v2 reembed enqueued",
  );
  return slugs.length;
}

// ---------------------------------------------------------------------------
// memory_v2_activation_recompute — refresh persisted activation state
// ---------------------------------------------------------------------------

/**
 * Hard cap on the number of conversations we touch per backfill run. Mirrors
 * the v1 graph maintenance scheduler's bias toward bounded work: a workspace
 * with thousands of inactive conversations should not block the worker.
 * Scheduling can re-enqueue the job to walk further once existing pages are
 * embedded.
 */
const ACTIVATION_RECOMPUTE_CONVERSATION_LIMIT = 500;

/**
 * Job handler: for every conversation with a persisted activation row, fetch
 * its last user/assistant exchange, recompute the activation map via the
 * standard pipeline (`selectCandidates` → `computeOwnActivation` →
 * `spreadActivation`), and persist the new map. No rendering, no injection
 * delta — this is the state-update side of the per-turn pipeline.
 *
 * Used after consolidation replaces or deletes pages that other conversations
 * still reference: without recompute, a stale slug above `epsilon` keeps
 * decaying in `state` and contributing to the candidate set even though its
 * page is gone. Recompute drops it to zero and lets it fall out of the
 * sparse map on the next save.
 */
export async function memoryV2ActivationRecomputeJob(
  _job: MemoryJob,
  config: AssistantConfig,
): Promise<number> {
  const workspaceDir = getWorkspaceDir();
  const database = getDb();

  const conversations = listConversations(
    ACTIVATION_RECOMPUTE_CONVERSATION_LIMIT,
  );
  const edgeIndex = await getEdgeIndex(workspaceDir);
  const nowText = await loadNowText(workspaceDir);

  let updated = 0;
  for (const conv of conversations) {
    const priorState = await hydrate(database, conv.id);
    if (!priorState) continue; // Nothing to recompute when no row exists.

    let nextState;
    try {
      nextState = await recomputeForConversation({
        conversationId: conv.id,
        priorState,
        edgeIndex,
        nowText,
        config,
      });
    } catch (err) {
      log.warn(
        { err, conversationId: conv.id },
        "Activation recompute failed for conversation; leaving prior state in place",
      );
      continue;
    }

    if (!nextState) continue;
    await save(database, conv.id, nextState);
    updated += 1;
  }

  log.info(
    { conversationsScanned: conversations.length, updated },
    "Memory v2 activation recompute complete",
  );
  return updated;
}

interface RecomputeForConversationParams {
  conversationId: string;
  priorState: NonNullable<Awaited<ReturnType<typeof hydrate>>>;
  edgeIndex: Awaited<ReturnType<typeof getEdgeIndex>>;
  nowText: string;
  config: AssistantConfig;
}

/**
 * Run the per-turn activation pipeline against the conversation's most
 * recent user/assistant texts and return the new state, or `null` if the
 * conversation has no usable messages (empty conv, fork-only, etc.).
 *
 * Filters out the prior `state` keys whose recomputed value falls at or below
 * `epsilon` so the persisted sparse map shrinks rather than growing.
 */
async function recomputeForConversation(
  params: RecomputeForConversationParams,
): Promise<Awaited<ReturnType<typeof hydrate>> | null> {
  const { conversationId, priorState, edgeIndex, nowText, config } = params;

  const { userText, assistantText } = lastExchangeTexts(conversationId);
  if (!userText && !assistantText) return null;

  const { candidates } = await selectCandidates({
    priorState,
    userText,
    assistantText,
    nowText,
    config,
  });
  const { activation: ownActivation } = await computeOwnActivation({
    candidates,
    priorState,
    userText,
    assistantText,
    nowText,
    config,
  });
  const { final: spread } = spreadActivation(
    ownActivation,
    edgeIndex,
    config.memory.v2.k,
    config.memory.v2.hops,
  );

  const epsilon = config.memory.v2.epsilon;
  const sparseState: Record<string, number> = {};
  for (const [slug, value] of spread) {
    if (value > epsilon) sparseState[slug] = value;
  }

  return {
    messageId: priorState.messageId,
    state: sparseState,
    everInjected: priorState.everInjected,
    currentTurn: priorState.currentTurn,
    updatedAt: Date.now(),
  };
}

/**
 * Pull the most recent user message and the most recent assistant message
 * from a conversation. We deliberately don't require them to be on the same
 * turn — a conversation that ended on the user's question still has both
 * texts to feed the recompute, just from different turns.
 *
 * Returns empty strings on missing rows so the recompute call can short-
 * circuit cleanly. Tool-call content is dropped (only `text` blocks survive)
 * — same shape `loadRecentMessagesText` produces in `sweep-job.ts`.
 */
function lastExchangeTexts(conversationId: string): {
  userText: string;
  assistantText: string;
} {
  const all = getMessages(conversationId);
  if (all.length === 0) return { userText: "", assistantText: "" };

  let userText = "";
  let assistantText = "";
  for (let i = all.length - 1; i >= 0; i--) {
    const row = all[i];
    if (!userText && row.role === "user") {
      userText = stringifyMessageContent(row.content);
    } else if (!assistantText && row.role === "assistant") {
      assistantText = stringifyMessageContent(row.content);
    }
    if (userText && assistantText) break;
  }
  return { userText, assistantText };
}
