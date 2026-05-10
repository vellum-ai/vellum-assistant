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
  recordMemoryV2ActivationLog,
} from "../memory-v2-activation-log-store.js";
import {
  computeOwnActivation,
  selectCandidates,
  selectInjections,
  spreadActivation,
} from "./activation.js";
import { hydrate, save } from "./activation-store.js";
import { getEdgeIndex } from "./edge-index.js";
import { readPage, renderPageContent } from "./page-store.js";
import { getSkillCapability, isSkillSlug } from "./skill-store.js";
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
  signal?: AbortSignal;
}

export interface InjectMemoryV2BlockResult {
  /**
   * Inner content for the `<memory>` block, ready for the caller to wrap
   * exactly once at injection time — or `null` when nothing new is eligible
   * for injection. `null` is the cache-stable default: the caller adds
   * nothing to the new user message and prior attachments stay
   * byte-identical.
   */
  block: string | null;
  /**
   * Slugs we attempted to attach this turn (top-K minus everInjected).
   * Always populated even when `block` is `null` — phantom slugs whose
   * backing page is missing on disk land here and are recorded in
   * `everInjected` so we don't infinite-retry next turn. Callers using
   * this for "we injected N slugs" telemetry should cross-reference
   * `block !== null` (or the activation log's `page_missing` status).
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
    signal,
  } = params;

  const workspaceDir = getWorkspaceDir();

  // (1) Hydrate. Missing rows are normal at conversation start — proceed
  // with an effective empty prior state so the first turn can still inject.
  throwIfAborted(signal);
  const priorState = await hydrate(database, conversationId);

  // (2) Topology. `getEdgeIndex` walks concept-page frontmatter and caches
  // the result module-locally; an empty workspace yields an empty index.
  throwIfAborted(signal);
  const edgeIndex = await getEdgeIndex(workspaceDir);

  // (3) Candidate set: prior-state survivors above epsilon ∪ ANN top-50.
  // `selectCandidates` also returns `fromPrior` / `fromAnn` provenance sets so
  // telemetry can attribute each candidate back to its source.
  throwIfAborted(signal);
  const { candidates, fromPrior, fromAnn } = await selectCandidates({
    priorState,
    userText: userMessage,
    assistantText: assistantMessage,
    nowText,
    config,
    signal,
  });

  // (4) Own activation: A_o = d·prev + c_user·sim_u + c_a·sim_a + c_now·sim_n.
  throwIfAborted(signal);
  const { activation: ownActivation, breakdown: ownBreakdown } =
    await computeOwnActivation({
      candidates,
      priorState,
      userText: userMessage,
      assistantText: assistantMessage,
      nowText,
      config,
      signal,
    });

  // (5) Spreading activation across the edge graph (k, hops from config).
  throwIfAborted(signal);
  const { k, hops, top_k, epsilon } = config.memory.v2;
  const { final: finalActivation, contribution: spreadContribution } =
    spreadActivation(ownActivation, edgeIndex, k, hops);

  // (6) Pick top-K by activation. Per-turn turns subtract everInjected for the
  // injection delta (cache-stable append-only); context-load renders the
  // entire top-K because it's a fresh load (turn 1 / post-compaction) where
  // prior cached attachments don't exist or have been thrown away. The user
  // message gets a complete top-K dump alongside the static
  // essentials/threads/recent block, then per-turn turns just add deltas.
  //
  // `mode` is `let` because the trailing try/finally promotes it to "errored"
  // when the render/telemetry path throws — we still want a log row written
  // (with whatever conceptRows we managed to build) so silent failures are
  // observable in the database.
  let mode: "context-load" | "per-turn" | "errored" = params.mode ?? "per-turn";
  const priorEverInjected: readonly EverInjectedEntry[] =
    priorState?.everInjected ?? [];
  const { topNow, toInject } = selectInjections({
    A: finalActivation,
    priorEverInjected,
    topK: top_k,
  });
  const slugsToRender = mode === "context-load" ? topNow : toInject;

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
  // injected slug. Skill slugs (`skills/<id>`) participate in this dedup just
  // like concept slugs — once attached on a turn, the cached attachment lives
  // on that user message and the agent keeps seeing it across subsequent turns
  // until compaction evicts the turn.
  //
  // Skill slugs whose in-process cache entry is missing (e.g. startup race
  // between the skill seed and the first turn, or stale Qdrant index pointing
  // at an uninstalled skill) are excluded from `everInjected` so future
  // per-turn runs re-attempt attachment once the cache is populated. Without
  // this, the slug would be marked injected even though `renderInjectionBlock`
  // silently dropped it.
  const missingSkillSlugs = new Set(
    slugsToRender.filter(
      (slug) => isSkillSlug(slug) && !getSkillCapability(slug),
    ),
  );
  const everInjectedSet = new Set(priorEverInjected.map((entry) => entry.slug));
  const newlyInjected = slugsToRender.filter(
    (slug) => !everInjectedSet.has(slug) && !missingSkillSlugs.has(slug),
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

  // `conceptRows` and `block` are declared outside the try so the finally
  // block can flush activation telemetry even if rendering, row-building, or
  // the activation-state save throws partway through. Without this, a Zod
  // failure on a single concept page (e.g. unrecognized frontmatter key)
  // silently dropped the entire turn's activation log row, masking the
  // underlying data-corruption bug.
  let conceptRows: MemoryV2ConceptRowRecord[] = [];
  let block: string | null = null;
  let caughtErr: unknown = undefined;
  const v2Cfg = config.memory.v2;

  try {
    await save(database, conversationId, nextActivationState);

    // Render before recording telemetry so the activation log can mark slugs
    // whose backing file is gone or failed to load — those are no-op renders
    // that would otherwise be indistinguishable from successful "injected"
    // rows in the log. `renderInjectionBlock` itself short-circuits on empty
    // inputs and emits per-slug `log.warn` for each corrupt page.
    const rendered = await renderInjectionBlock(workspaceDir, slugsToRender);
    block = rendered.block;
    const { missingSlugs, corruptSlugs } = rendered;
    const missingSlugSet = new Set(missingSlugs);
    const corruptSlugSet = new Set(corruptSlugs);
    if (missingSlugs.length > 0) {
      log.warn(
        {
          conversationId,
          turn: currentTurn,
          missingSlugs,
          renderedCount:
            slugsToRender.length - missingSlugs.length - corruptSlugs.length,
        },
        "Memory v2 injection skipped slugs whose page was missing on disk — Qdrant index may be stale; consider reembed",
      );
    }

    // Record per-turn activation telemetry. Failures are warn-logged in the
    // finally block and never block memory injection.
    const toInjectSet = new Set(toInject);
    const renderedSet = new Set(slugsToRender);
    conceptRows = [...candidates].map((slug) => {
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
      // `page_missing` and `corrupt` override any "would-have-been-injected"
      // status when `readPage` returned null or threw — telemetry surfaces
      // stale ANN/edge entries and malformed pages instead of silently
      // masquerading as successful injections. `corrupt` takes priority over
      // `page_missing` since they're mutually exclusive per slug.
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
      if (status === "injected" && missingSlugSet.has(slug)) {
        status = "page_missing";
      }
      if (corruptSlugSet.has(slug)) {
        status = "corrupt";
      }
      return {
        slug,
        finalActivation: finalActivation.get(slug) ?? 0,
        ownActivation: ownActivation.get(slug) ?? 0,
        priorActivation: breakdown?.priorContribution ?? 0,
        simUser: breakdown?.simUser ?? 0,
        simAssistant: breakdown?.simAssistant ?? 0,
        simNow: breakdown?.simNow ?? 0,
        simUserRerankBoost: breakdown?.simUserRerankBoost ?? 0,
        simAssistantRerankBoost: breakdown?.simAssistantRerankBoost ?? 0,
        inRerankPool: breakdown?.inRerankPool ?? false,
        spreadContribution: spreadContribution.get(slug) ?? 0,
        source:
          inPrior && inAnn ? "both" : inPrior ? "prior_state" : "ann_top50",
        status,
      };
    });
    conceptRows.sort((a, b) => b.finalActivation - a.finalActivation);
  } catch (err) {
    // Stash the error and let `finally` flush a best-effort telemetry row
    // before we re-throw to the caller. `mode = "errored"` flags the row
    // for observability dashboards / inspector queries.
    caughtErr = err;
    mode = "errored";
  } finally {
    try {
      recordMemoryV2ActivationLog({
        conversationId,
        turn: currentTurn,
        mode,
        concepts: conceptRows,
        config: {
          d: v2Cfg.d,
          c_user: v2Cfg.c_user,
          c_assistant: v2Cfg.c_assistant,
          c_now: v2Cfg.c_now,
          k: v2Cfg.k,
          hops: v2Cfg.hops,
          top_k: v2Cfg.top_k,
          epsilon: v2Cfg.epsilon,
        },
      });
    } catch (telemetryErr) {
      log.warn(
        { err: telemetryErr, conversationId, turn: currentTurn },
        "Failed to record memory v2 activation telemetry — continuing",
      );
    }
  }

  if (caughtErr !== undefined) throw caughtErr;
  return { block, toInject: newlyInjected };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface RenderInjectionBlockResult {
  /**
   * Inner content for the `<memory>` block (concept-page sections + optional
   * skills suffix), or `null` when both the concept-page list and the skill
   * list collapse to empty after cache misses (no on-disk pages, no
   * resolvable skill ids). Returned unwrapped so the caller can wrap it
   * exactly once at injection time, matching v1's contract: callers that
   * cache the value (`lastInjectedBlock`) or persist it (`memoryInjectedBlock`
   * in message metadata) re-wrap on use, and storing the wrapped form here
   * caused a double wrap on reinject after compaction and on rehydrate from
   * DB.
   */
  block: string | null;
  /**
   * Slugs that `readPage` returned null for. Surfaced so the caller can
   * mark them in the activation log (`status: "page_missing"`) and emit
   * a warning — silent drops here previously masked stale Qdrant /
   * edge-index entries that pointed at pages no longer on disk.
   */
  missingSlugs: string[];
  /**
   * Slugs whose `readPage` call threw (e.g. invalid frontmatter that fails
   * Zod validation, unreadable file). These are reported separately from
   * `missingSlugs` because they're a different failure mode — the file
   * exists but is malformed, not absent — and surfaced so the caller can
   * mark them in the activation log (`status: "corrupt"`). Per-page errors
   * are isolated: one bad page no longer rejects the whole batch.
   */
  corruptSlugs: string[];
}

/**
 * Leading instruction line emitted at the top of an injection block when at
 * least one section was rendered from a page's `summary` field. Tells the
 * agent the truncated entries are summaries and to read the underlying file
 * if relevant. Suppressed when every section is a full-page fallback —
 * claiming "these are summaries" over already-complete content would mislead
 * the agent into wasted reads.
 */
const INJECTION_HEADER =
  "**CRITICAL:** These are page summaries. Read the page file if it looks relevant.";

/**
 * Render the inner content of the `<memory>` block for a list of slugs.
 * The caller wraps the result in `<memory>...</memory>` exactly once at
 * injection time.
 *
 * The slug list is partitioned by prefix: slugs starting with `skills/`
 * resolve to a `SkillEntry` via `getSkillCapability` and render under the
 * trailing `### Skills You Can Use` subsection; everything else is read
 * from disk via `readPage` and rendered as a concept-page section.
 *
 * Concept pages are read in parallel via `Promise.allSettled`. Per-page
 * errors are isolated: a `readPage` rejection (e.g. invalid frontmatter
 * failing Zod validation) collects the slug into `corruptSlugs` and the
 * remaining pages still render normally. Pages whose file has gone missing
 * between selection and render (e.g. consolidation deleted them, folder
 * reorg renamed the slug) are dropped from the rendered block but reported
 * back via `missingSlugs`. The two buckets are kept separate so callers can
 * distinguish "file vanished" (stale index) from "file is malformed"
 * (data-corruption / programmer error).
 *
 * Skill slugs whose entry the cache no longer knows (e.g. uninstalled
 * mid-run) are silently dropped, mirroring the missing-pages behavior but
 * without entering `missingSlugs` — the skill catalog is the source of
 * truth for skill availability, not on-disk concept pages, so a missing
 * skill is an expected catalog-level outcome rather than a stale-index
 * bug.
 *
 * Each concept-page section is rendered as a path header followed by either
 * the page's `summary` (when present in frontmatter) or the full page (the
 * fallback for pages predating the summary field). Skills sit at the end
 * under `### Skills You Can Use`, unchanged. The leading `**CRITICAL:**`
 * line tells the agent how to read the block.
 *
 *   **CRITICAL:** These are page summaries. Read the page file if it looks relevant.
 *
 *   # memory/concepts/<concept-slug-1>.md
 *   <summary-1>
 *
 *   # memory/concepts/<concept-slug-2>.md
 *   ---
 *   edges:
 *     - <neighbor-slug>
 *   ref_files:
 *     - <path/to/asset>
 *   ---
 *   <body-2>
 *
 *   ### Skills You Can Use
 *   - <skill-1 content>
 *   - <skill-2 content>
 */
async function renderInjectionBlock(
  workspaceDir: string,
  slugs: string[],
): Promise<RenderInjectionBlockResult> {
  const conceptSlugs = slugs.filter((s) => !isSkillSlug(s));
  const skillSlugs = slugs.filter((s) => isSkillSlug(s));

  const settled = await Promise.allSettled(
    conceptSlugs.map((slug) => readPage(workspaceDir, slug)),
  );

  const sections: string[] = [];
  const missingSlugs: string[] = [];
  const corruptSlugs: string[] = [];
  let anySummarySection = false;
  for (let i = 0; i < settled.length; i++) {
    const slug = conceptSlugs[i]!;
    const result = settled[i]!;
    if (result.status === "rejected") {
      corruptSlugs.push(slug);
      log.warn(
        { slug, err: result.reason },
        "Memory v2 injection skipped slug whose page failed to load — frontmatter may be malformed",
      );
      continue;
    }
    const page = result.value;
    if (!page) {
      missingSlugs.push(slug);
      continue;
    }
    const summary = page.frontmatter.summary?.trim();
    const path = `memory/concepts/${slug}.md`;
    if (summary && summary.length > 0) {
      sections.push(`# ${path}\n${summary}`);
      anySummarySection = true;
      continue;
    }
    // Fallback: page predates the `summary` field (or the field was set to
    // empty). Render the full page — frontmatter + body — so retrieval
    // still surfaces the same content the agent saw before this change.
    const content = renderPageContent(page).trim();
    if (content.length === 0) continue;
    sections.push(`# ${path}\n${content}`);
  }

  const skillLines: string[] = [];
  for (const slug of skillSlugs) {
    const entry = getSkillCapability(slug);
    if (!entry) continue;
    skillLines.push(`- ${entry.content} → use skill_load to activate`);
  }
  if (skillLines.length > 0) {
    sections.push(`### Skills You Can Use\n${skillLines.join("\n")}`);
  }

  if (sections.length === 0) {
    return { block: null, missingSlugs, corruptSlugs };
  }

  const body = sections.join("\n\n");
  return {
    block: anySummarySection ? `${INJECTION_HEADER}\n\n${body}` : body,
    missingSlugs,
    corruptSlugs,
  };
}
