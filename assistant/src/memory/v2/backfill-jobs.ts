// ---------------------------------------------------------------------------
// Memory v2 — Backfill job handlers
// ---------------------------------------------------------------------------
//
// Four operator-triggered backfills, all wired through the same job queue so
// they can be enqueued from the IPC route, the CLI, or recovery paths:
//
//   - `memory_v2_migrate`              — one-shot v1→v2 synthesis (PR 16).
//   - `memory_v2_rebuild_edges`        — regenerate every page's `edges:`
//     frontmatter from `memory/edges.json` (the source of truth for graph
//     topology). Defensive against drift, hand-edits, and consolidation
//     leaving stale frontmatter behind.
//   - `memory_v2_reembed`              — fan out an `embed_concept_page` job
//     per slug, plus four reserved-slug jobs for the meta files
//     (`__essentials__`, `__threads__`, `__recent__`, `__buffer__`).
//   - `memory_v2_activation_recompute` — recompute persisted activation
//     state for every conversation, no rendering. Used after consolidation
//     replaces or deletes pages that other conversations still reference.
//
// Each handler is intentionally small — heavy lifting lives in the modules
// they delegate to (`migration.ts`, `edges.ts`, `page-store.ts`,
// `embed-concept-page.ts`, `activation.ts`, `activation-store.ts`). Keeping
// the wrappers thin means the same code paths exercised by tests of those
// modules run unchanged when a backfill kicks them off.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AssistantConfig } from "../../config/types.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { getMessages } from "../conversation-crud.js";
import { listConversations } from "../conversation-queries.js";
import { getDb } from "../db-connection.js";
import { enqueueEmbedConceptPageJob } from "../jobs/embed-concept-page.js";
import type { MemoryJob } from "../jobs-store.js";
import {
  computeOwnActivation,
  selectCandidates,
  spreadActivation,
} from "./activation.js";
import { hydrate, save } from "./activation-store.js";
import { readEdges } from "./edges.js";
import {
  MigrationAlreadyAppliedError,
  runMemoryV2Migration,
} from "./migration.js";
import { listPages, readPage, writePage } from "./page-store.js";

const log = getLogger("memory-v2-backfill");

/**
 * Reserved slugs the reembed job enqueues alongside the concept-page slugs.
 * These name the four prose meta files (essentials/threads/recent/buffer)
 * loaded into the system prompt by PR 11. Embedding them is forward-looking
 * — the existing `embed-concept-page` handler treats unknown slugs as
 * deletions (a no-op when no embedding exists), so enqueueing here is safe
 * regardless of whether the meta files are ever embedded for retrieval.
 */
export const META_FILE_SLUGS = [
  "__essentials__",
  "__threads__",
  "__recent__",
  "__buffer__",
] as const;

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
// memory_v2_rebuild_edges — recompute every page's edges: frontmatter
// ---------------------------------------------------------------------------

/**
 * Job handler: walk every concept page on disk, recompute its `edges:`
 * frontmatter from `memory/edges.json`, and write back via `writePage` so
 * the YAML block reflects the current topology.
 *
 * `memory/edges.json` is the source of truth for graph topology — frontmatter
 * is a derived view that downstream readers (LLM during consolidation,
 * humans inspecting pages) consume but never mutate. The rebuild is
 * defensive against three failure modes:
 *   1. A consolidation pass replaced a page's body but didn't update its
 *      `edges:` list (missed write).
 *   2. A user hand-edited a page and replaced or removed the `edges:` list.
 *   3. An older v2 build wrote frontmatter without canonical ordering.
 *
 * Other frontmatter fields (`ref_files`) are preserved as-is — the page
 * remains the only source of truth for everything beyond `edges`. Pages
 * that fail to read are logged and skipped so one corrupt page doesn't
 * block the rest of the rebuild.
 */
export async function memoryV2RebuildEdgesJob(
  _job: MemoryJob,
  _config: AssistantConfig,
): Promise<void> {
  const workspaceDir = getWorkspaceDir();
  const idx = await readEdges(workspaceDir);

  // Build slug → sorted neighbor list once, then look up per page. Sets
  // dedup automatically; sorting at materialization time keeps the
  // rendered YAML stable across runs.
  const neighborsBySlug = new Map<string, Set<string>>();
  const ensureSet = (slug: string): Set<string> => {
    let set = neighborsBySlug.get(slug);
    if (!set) {
      set = new Set<string>();
      neighborsBySlug.set(slug, set);
    }
    return set;
  };
  for (const [a, b] of idx.edges) {
    if (a === b) continue;
    ensureSet(a).add(b);
    ensureSet(b).add(a);
  }

  const slugs = await listPages(workspaceDir);
  let rewritten = 0;
  for (const slug of slugs) {
    let page;
    try {
      page = await readPage(workspaceDir, slug);
    } catch (err) {
      log.warn({ err, slug }, "Skipping page with unreadable frontmatter");
      continue;
    }
    if (!page) continue;

    const desired = [...(neighborsBySlug.get(slug) ?? [])].sort();
    if (
      page.frontmatter.edges.length === desired.length &&
      page.frontmatter.edges.every((e, i) => e === desired[i])
    ) {
      continue;
    }

    await writePage(workspaceDir, {
      ...page,
      frontmatter: { ...page.frontmatter, edges: desired },
    });
    rewritten += 1;
  }

  log.info(
    { slugCount: slugs.length, rewritten },
    "Memory v2 rebuild-edges complete",
  );
}

// ---------------------------------------------------------------------------
// memory_v2_reembed — fan out embed jobs for every page + meta file
// ---------------------------------------------------------------------------

/**
 * Job handler: enqueue an `embed_concept_page` job per concept-page slug, plus
 * one job per reserved meta-file slug ({@link META_FILE_SLUGS}).
 *
 * Returns the total number of jobs enqueued — `concept-page count + 4`.
 * Callers (and tests) use the return value to assert progress without
 * inspecting the job table directly.
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
  for (const slug of META_FILE_SLUGS) {
    enqueueEmbedConceptPageJob({ slug });
  }

  const total = slugs.length + META_FILE_SLUGS.length;
  log.info(
    { conceptPages: slugs.length, metaFiles: META_FILE_SLUGS.length, total },
    "Memory v2 reembed enqueued",
  );
  return total;
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
  const edgesIdx = await readEdges(workspaceDir);
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
        edgesIdx,
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
  edgesIdx: Awaited<ReturnType<typeof readEdges>>;
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
  const { conversationId, priorState, edgesIdx, nowText, config } = params;

  const { userText, assistantText } = lastExchangeTexts(conversationId);
  if (!userText && !assistantText) return null;

  const candidates = await selectCandidates({
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
    edgesIdx,
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

/**
 * Coerce stored message content (JSON-serialized `ContentBlock[]` *or* plain
 * string in legacy rows) into a single text string. Image / tool blocks are
 * dropped — recompute only needs the spoken text.
 */
function stringifyMessageContent(stored: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return stored.trim();
  }
  if (typeof parsed === "string") return parsed.trim();
  if (!Array.isArray(parsed)) return "";
  const parts: string[] = [];
  for (const block of parsed) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n").trim();
}

/**
 * Read the prose meta files that compose the "NOW" context the activation
 * pipeline correlates against. Mirrors the autoload order in
 * `system-prompt.ts` so the same prose drives both injection and recompute.
 * Missing or unreadable files are treated as empty.
 */
async function loadNowText(workspaceDir: string): Promise<string> {
  const filenames = ["essentials.md", "threads.md", "recent.md"];
  const reads = await Promise.all(
    filenames.map(async (filename) => {
      try {
        const text = await readFile(
          join(workspaceDir, "memory", filename),
          "utf-8",
        );
        return text.trim();
      } catch {
        return "";
      }
    }),
  );
  return reads.filter((part) => part.length > 0).join("\n\n");
}
