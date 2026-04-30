// ---------------------------------------------------------------------------
// Memory v2 — Per-turn injection block builder
// ---------------------------------------------------------------------------
//
// Drop-in replacement for v1's `injectMemoryBlock()` (graph/conversation-graph-memory.ts).
// Implements §5 of the design doc:
//
//   1. Hydrate prior activation state for the conversation.
//   2. Build the in-memory edge index from concept-page frontmatter.
//   3. Select the per-turn candidate set (prior-state survivors ∪ ANN top-K).
//   4. Compute own activation A_o over the candidates.
//   5. Apply 2-hop spreading activation along directed edges (incoming) → A.
//   6. Pick top-K by activation; subtract everInjected to get the injection delta.
//   7. If no new slugs, render nothing — caller leaves the prior cached
//      attachments on prior user messages exactly as Anthropic prompt caching
//      requires.
//   8. Otherwise render a `<memory>` block scoped to the *new* slugs
//      ordered by activation (descending) and persist the updated state +
//      everInjected list (with `currentTurn` annotated) so future turns can
//      append-inject cache-stably.
//
// Append-only on user messages: callers prepend `block` onto the *current*
// user message only — prior turns' attachments are left alone. This keeps the
// cached prefix bytes-identical across turns.

import type { AssistantConfig } from "../../config/types.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import type { DrizzleDb } from "../db-connection.js";
import {
  type MemoryV2ConceptRowRecord,
  type MemoryV2SkillRowRecord,
  recordMemoryV2ActivationLog,
} from "../memory-v2-activation-log-store.js";
import {
  computeOwnActivation,
  computeSkillActivation,
  selectCandidates,
  selectInjections,
  selectSkillCandidates,
  selectSkillInjections,
  spreadActivation,
} from "./activation.js";
import { hydrate, save } from "./activation-store.js";
import { getEdgeIndex } from "./edge-index.js";
import { readPage, renderPageContent } from "./page-store.js";
import { getSkillCapability } from "./skill-store.js";
import type { ActivationState, EverInjectedEntry } from "./types.js";

const log = getLogger("memory-v2-injection");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Discriminator the wiring layer (`conversation-graph-memory.ts`) sets to
 * tell the v2 injector which call site is asking. Both modes currently share
 * the same block layout (mirroring v1 which also wraps both flows in
 * `<memory>...</memory>`); the parameter exists so future tuning
 * can shape the conversation-start block without touching the call site.
 */
export type InjectMemoryV2Mode = "context-load" | "per-turn";

export interface InjectMemoryV2BlockParams {
  /** SQLite database handle for activation_state hydrate/save. */
  database: DrizzleDb;
  /** Conversation key for hydrate/save. */
  conversationId: string;
  /** Caller-tracked turn number, persisted with each new everInjected entry. */
  currentTurn: number;
  /** Latest user message text (the turn that triggered this call). */
  userMessage: string;
  /** Prior assistant message text (empty string at conversation start). */
  assistantMessage: string;
  /** NOW context (autoloaded essentials/threads/recent or NOW.md). */
  nowText: string;
  /** Resolved messageId to persist on the activation_state row. */
  messageId: string;
  /**
   * Whether the caller is doing a fresh context-load (turn 1 / post-compaction)
   * or a per-turn append injection. Currently informational — both modes
   * produce the same block layout — but accepted so callers don't have to
   * change when the layouts diverge.
   */
  mode?: InjectMemoryV2Mode;
  config: AssistantConfig;
}

export interface InjectMemoryV2BlockResult {
  /**
   * Rendered `<memory>` block, ready to prepend to the current
   * user message — or `null` when nothing new is eligible for injection.
   * `null` is the cache-stable default: the caller adds nothing to the new
   * user message and prior attachments stay byte-identical.
   */
  block: string | null;
  /**
   * Slugs that were freshly attached on this turn. Empty when `block` is
   * null. Returned for telemetry / debug logging by the call site.
   */
  toInject: string[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Compute the per-turn activation update for a conversation, persist the new
 * state, and return a renderable injection block scoped to the *new* slugs
 * since the last turn (or `null` when nothing new is eligible).
 *
 * The function is idempotent in shape but mutating in effect: it always
 * writes a fresh activation_state row even when `block` is null, so the
 * `epsilon`-trimmed sparse state stays current and `currentTurn` advances.
 */
export async function injectMemoryV2Block(
  params: InjectMemoryV2BlockParams,
): Promise<InjectMemoryV2BlockResult> {
  const {
    database,
    conversationId,
    currentTurn,
    userMessage,
    assistantMessage,
    nowText,
    messageId,
    config,
  } = params;

  const workspaceDir = getWorkspaceDir();

  // (1) Hydrate. Missing rows are normal at conversation start — proceed
  // with an effective empty prior state so the first turn can still inject.
  const priorState = await hydrate(database, conversationId);

  // (2) Topology. `getEdgeIndex` walks concept-page frontmatter and caches
  // the result module-locally; an empty workspace yields an empty index.
  const edgeIndex = await getEdgeIndex(workspaceDir);

  // (3) Candidate set: prior-state survivors above epsilon ∪ ANN top-50.
  // `selectCandidates` also returns `fromPrior` / `fromAnn` provenance sets so
  // telemetry can attribute each candidate back to its source.
  const { candidates, fromPrior, fromAnn } = await selectCandidates({
    priorState,
    userText: userMessage,
    assistantText: assistantMessage,
    nowText,
    config,
  });

  // (4) Own activation: A_o = d·prev + c_user·sim_u + c_a·sim_a + c_now·sim_n.
  const { activation: ownActivation, breakdown: ownBreakdown } =
    await computeOwnActivation({
      candidates,
      priorState,
      userText: userMessage,
      assistantText: assistantMessage,
      nowText,
      config,
    });

  // (5) Spreading activation across the edge graph (k, hops from config).
  const { k, hops, top_k, epsilon } = config.memory.v2;
  const { final: finalActivation, contribution: spreadContribution } =
    spreadActivation(ownActivation, edgeIndex, k, hops);

  // (6) Pick top-K by activation. Per-turn turns subtract everInjected for the
  // injection delta (cache-stable append-only); context-load renders the
  // entire top-K because it's a fresh load (turn 1 / post-compaction) where
  // prior cached attachments don't exist or have been thrown away. The user
  // message gets a complete top-K dump alongside the static
  // essentials/threads/recent block, then per-turn turns just add deltas.
  const mode = params.mode ?? "per-turn";
  const priorEverInjected: readonly EverInjectedEntry[] =
    priorState?.everInjected ?? [];
  const { topNow, toInject } = selectInjections({
    A: finalActivation,
    priorEverInjected,
    topK: top_k,
  });
  const slugsToRender = mode === "context-load" ? topNow : toInject;

  // (6b) Skill pipeline — a sibling pipeline to the concept-page one above.
  // Skills are stateless: no decay carry-over, no spread, no `everInjected`
  // dedup. The top-K relevant skills are re-presented every turn so the
  // agent can drop and pick them up freely.
  const skillCandidates = await selectSkillCandidates({
    userText: userMessage,
    assistantText: assistantMessage,
    nowText,
    config,
    topK: config.memory.v2.top_k_skills,
  });
  const { activation: skillActivation, breakdown: skillBreakdown } =
    await computeSkillActivation({
      candidates: skillCandidates,
      userText: userMessage,
      assistantText: assistantMessage,
      nowText,
      config,
    });
  const { topNow: topSkillIds } = selectSkillInjections({
    A: skillActivation,
    topK: config.memory.v2.top_k_skills,
  });

  // Build the next persisted state regardless of whether we render anything:
  // even on a "no new injection" turn, prior-state activations decay via the
  // candidate-set carry-forward and need to be rewritten so `epsilon`-trimmed
  // slugs drop out of consideration next turn.
  const nextState: Record<string, number> = {};
  for (const [slug, value] of finalActivation) {
    if (value > epsilon) nextState[slug] = value;
  }

  // Mark every rendered slug as ever-injected so future per-turn deltas don't
  // re-attach the same content. On context-load this is the full top-K (we
  // just rendered all of them); on per-turn it's just the newly added slugs.
  // We append rather than reset so that compaction-driven eviction
  // (`evictCompactedTurns`) is the only path that can re-enable a previously-
  // injected slug. Skills do NOT enter `everInjected` — they are stateless
  // and re-presented every turn.
  const everInjectedSet = new Set(priorEverInjected.map((entry) => entry.slug));
  const newlyInjected = slugsToRender.filter(
    (slug) => !everInjectedSet.has(slug),
  );
  const nextEverInjected: EverInjectedEntry[] = [
    ...priorEverInjected,
    ...newlyInjected.map((slug) => ({ slug, turn: currentTurn })),
  ];

  const nextActivationState: ActivationState = {
    messageId,
    state: nextState,
    everInjected: nextEverInjected,
    currentTurn,
    updatedAt: Date.now(),
  };

  await save(database, conversationId, nextActivationState);

  // Record per-turn activation telemetry. This runs *before* the cache-stable
  // empty-block return so we capture diagnostics even on no-op turns. Failures
  // are warn-logged and never block memory injection.
  const toInjectSet = new Set(toInject);
  const renderedSet = new Set(slugsToRender);
  const topSkillIdSet = new Set(topSkillIds);
  const conceptRows: MemoryV2ConceptRowRecord[] = [...candidates].map(
    (slug) => {
      const breakdown = ownBreakdown.get(slug);
      const inPrior = fromPrior.has(slug);
      const inAnn = fromAnn.has(slug);
      // Status reflects what was rendered for *this* turn:
      //   - context-load: cache was wiped (turn 1 / post-compaction), so
      //     `slugsToRender = topNow` and every rendered slug is freshly
      //     injected on this turn. `in_context` is unreachable because there
      //     is no prior cached attachment for the inspector to point at.
      //   - per-turn: cached attachments from prior turns are still on the
      //     user message, so prior-everInjected slugs are `in_context` and
      //     the delta (`toInject`) is `injected`.
      let status: MemoryV2ConceptRowRecord["status"];
      if (mode === "context-load") {
        status = renderedSet.has(slug) ? "injected" : "not_injected";
      } else if (everInjectedSet.has(slug)) {
        status = "in_context";
      } else if (toInjectSet.has(slug)) {
        status = "injected";
      } else {
        status = "not_injected";
      }
      return {
        slug,
        finalActivation: finalActivation.get(slug) ?? 0,
        ownActivation: ownActivation.get(slug) ?? 0,
        priorActivation: breakdown?.priorContribution ?? 0,
        simUser: breakdown?.simUser ?? 0,
        simAssistant: breakdown?.simAssistant ?? 0,
        simNow: breakdown?.simNow ?? 0,
        spreadContribution: spreadContribution.get(slug) ?? 0,
        source:
          inPrior && inAnn ? "both" : inPrior ? "prior_state" : "ann_top50",
        status,
      };
    },
  );
  conceptRows.sort((a, b) => b.finalActivation - a.finalActivation);

  const skillRows: MemoryV2SkillRowRecord[] = [...skillCandidates].map((id) => {
    const breakdown = skillBreakdown.get(id);
    return {
      id,
      activation: skillActivation.get(id) ?? 0,
      simUser: breakdown?.simUser ?? 0,
      simAssistant: breakdown?.simAssistant ?? 0,
      simNow: breakdown?.simNow ?? 0,
      status: topSkillIdSet.has(id) ? "injected" : "not_injected",
    };
  });
  skillRows.sort((a, b) => b.activation - a.activation);

  const v2Cfg = config.memory.v2;
  try {
    recordMemoryV2ActivationLog({
      conversationId,
      turn: currentTurn,
      mode,
      concepts: conceptRows,
      skills: skillRows,
      config: {
        d: v2Cfg.d,
        c_user: v2Cfg.c_user,
        c_assistant: v2Cfg.c_assistant,
        c_now: v2Cfg.c_now,
        k: v2Cfg.k,
        hops: v2Cfg.hops,
        top_k: v2Cfg.top_k,
        top_k_skills: v2Cfg.top_k_skills,
        epsilon: v2Cfg.epsilon,
      },
    });
  } catch (err) {
    log.warn(
      { err, conversationId, turn: currentTurn },
      "Failed to record memory v2 activation telemetry — continuing",
    );
  }

  // (7) Cache-stable empty path: nothing to render AND no ranked skills.
  if (slugsToRender.length === 0 && topSkillIds.length === 0) {
    return { block: null, toInject: [] };
  }

  // (8) Render. Both `topNow` and `toInject` are activation-descending
  // (selectInjections sorts before slicing), so `slugsToRender` doubles as
  // the render order. Per-turn: only the new slugs render (prior turns'
  // attachments stay cached on prior user messages). Context-load: full
  // top-K renders so the fresh user message gets a complete activation dump.
  // Skills are appended after concept-page sections.
  const block = await renderInjectionBlock(
    workspaceDir,
    slugsToRender,
    topSkillIds,
  );

  return { block, toInject: newlyInjected };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Render the `<memory>` block for a list of slugs and a list of
 * ranked skill ids.
 *
 * Concept pages are read in parallel via `readPage`. Pages whose file has
 * gone missing between selection and render (e.g. consolidation deleted
 * them) are silently dropped — the activation state still records them in
 * `everInjected` so we don't keep re-attempting on every turn.
 *
 * Skill ids are looked up via `getSkillCapability`. Ids that the cache no
 * longer knows (e.g. uninstalled mid-run) are silently dropped, mirroring
 * the missing-pages behavior.
 *
 * The block shape is the §5 layout from the design doc, with an optional
 * trailing skills subsection. Each concept-page section reproduces the page
 * as it lives on disk — frontmatter (`edges`, `ref_files`) plus body — so
 * the agent sees the page's edges and any referenced media paths alongside
 * the prose:
 *
 *   <memory>
 *   ### <slug-1>
 *   ---
 *   edges:
 *     - <neighbor-slug>
 *   ref_files:
 *     - <path/to/asset>
 *   ---
 *   <body-1>
 *
 *   ### <slug-2>
 *   ---
 *   edges: []
 *   ref_files: []
 *   ---
 *   <body-2>
 *
 *   ### Skills You Can Use
 *   - <skill-1 content>
 *   - <skill-2 content>
 *   </memory>
 *
 * Returns `null` when both lists collapse to empty after cache misses so
 * the caller can fall through to its empty-block path instead of attaching
 * an empty `<memory>` wrapper.
 */
async function renderInjectionBlock(
  workspaceDir: string,
  slugs: string[],
  skillIds: string[],
): Promise<string | null> {
  const pages = await Promise.all(
    slugs.map(async (slug) => {
      const page = await readPage(workspaceDir, slug);
      return page ? { slug, content: renderPageContent(page).trim() } : null;
    }),
  );

  const sections: string[] = [];
  for (const entry of pages) {
    if (!entry || entry.content.length === 0) continue;
    sections.push(`### ${entry.slug}\n${entry.content}`);
  }

  // v2's skills collection is skills-only, so the activation suffix always applies.
  const skillLines: string[] = [];
  for (const id of skillIds) {
    const entry = getSkillCapability(id);
    if (!entry) continue;
    skillLines.push(`- ${entry.content} → use skill_load to activate`);
  }
  if (skillLines.length > 0) {
    sections.push(`### Skills You Can Use\n${skillLines.join("\n")}`);
  }

  if (sections.length === 0) return null;

  return `<memory>\n${sections.join("\n\n")}\n</memory>`;
}
