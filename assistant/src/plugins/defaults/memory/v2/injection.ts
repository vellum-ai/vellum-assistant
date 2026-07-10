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

import type { AssistantConfig } from "../../../../config/types.js";
import type { DrizzleDb } from "../../../../persistence/db-connection.js";
import { getWorkspaceDir } from "../../../../util/platform.js";
import { getLogger } from "../logging.js";
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
import {
  getCliCommandCapability,
  isCliCommandSlug,
} from "./cli-command-store.js";
import { getEdgeIndex } from "./edge-index.js";
import { recordInjectionEvents } from "./injection-events.js";
import { getPageIndex } from "./page-index.js";
import { readPage, renderPageContent } from "./page-store.js";
import { type RouterTurnPair, runRouter } from "./router.js";
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

/**
 * Internal mode union for `finalizeInjection`. Extends the public
 * `InjectMemoryV2Mode` with `"router"` (router-driven success path) and
 * `"errored"` (caller-supplied failure path or the helper's own
 * try/catch promotion). The public surface intentionally only carries
 * the caller-facing modes — these two are persistence/telemetry concerns
 * that don't belong on `InjectMemoryV2BlockParams`.
 */
type FinalizeInjectionMode = InjectMemoryV2Mode | "router" | "errored";

export interface InjectMemoryV2BlockParams {
  /** SQLite database handle for activation_state hydrate/save. */
  database: DrizzleDb;
  /** Conversation key for hydrate/save. */
  conversationId: string;
  /** Caller-tracked turn number, persisted with each new everInjected entry. */
  currentTurn: number;
  /**
   * Recent assistant/user turn pairs, oldest first. Must contain at least
   * one entry whose `userMessage` is the just-arrived turn that triggered
   * this call. The number of pairs the production caller passes is
   * controlled by `memory.v2.router.historical_pairs`.
   */
  recentTurnPairs: readonly RouterTurnPair[];
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
    recentTurnPairs,
    nowText,
    messageId,
    config,
    signal,
  } = params;

  // The spreading-activation fallback (only used when the router is off)
  // still needs the most recent (assistant, user) pair for semantic
  // scoring. Pulling these from the last pair preserves bit-identical
  // K=1 behavior — the router-off path never benefits from extra pairs.
  const lastPair = recentTurnPairs[recentTurnPairs.length - 1];
  const userMessage = lastPair.userMessage;
  const assistantMessage = lastPair.assistantMessage;

  const workspaceDir = getWorkspaceDir();
  const mode: InjectMemoryV2Mode = params.mode ?? "per-turn";

  // (1) Hydrate. Missing rows are normal at conversation start — proceed
  // with an effective empty prior state so the first turn can still inject.
  throwIfAborted(signal);
  const priorState = await hydrate(database, conversationId);

  // Flag-gated router dispatch: when the LLM router is enabled, route the
  // page selection through `runRouter` and reuse `finalizeInjection` for
  // persistence, render, and telemetry. The activation pipeline below
  // remains the default (flag-off) behavior — every code path past this
  // branch only runs when the router is disabled.
  //
  // Runs on both `per-turn` and `context-load`. The `everInjected` dedupe
  // concern from earlier doesn't apply post-compaction because
  // `evictCompactedTurnsV2` in `ConversationGraphMemory.onCompacted`
  // empties the list before this code runs. Router abstention on
  // context-load means no v2 pages restored that turn, which is preferable
  // to letting the activation graph pick something arbitrary.
  if (config.memory.v2.router.enabled) {
    return injectViaRouter({
      workspaceDir,
      database,
      conversationId,
      currentTurn,
      recentTurnPairs,
      nowText,
      messageId,
      config,
      priorState,
      signal,
    });
  }

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
  const nextStateMap: Record<string, number> = {};
  for (const [slug, value] of finalActivation) {
    if (value > epsilon) nextStateMap[slug] = value;
  }

  // Build the rich per-candidate telemetry rows up front (status assigned
  // later by `finalizeInjection` once we know what actually rendered).
  const telemetryRows: MemoryV2ConceptRowRecord[] = [...candidates].map(
    (slug) => {
      const breakdown = ownBreakdown.get(slug);
      const inPrior = fromPrior.has(slug);
      const inAnn = fromAnn.has(slug);
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
        status: "not_injected",
      };
    },
  );

  return finalizeInjection({
    workspaceDir,
    database,
    conversationId,
    mode,
    currentTurn,
    messageId,
    priorEverInjected,
    slugsToRender,
    telemetryRows,
    config,
    nextStateMap,
  });
}

/**
 * Tail of `injectMemoryV2Block` extracted as a private helper so the
 * router branch (PR 10) can reuse the same persistence + render +
 * telemetry-finalization pipeline. Performs:
 *
 *   1. Build `nextEverInjected` from `slugsToRender`, filtering out skill
 *      slugs whose capability cache entry is missing so future turns
 *      re-attempt attachment once the cache is populated.
 *   2. Persist the next activation_state row.
 *   3. Render the injection block.
 *   4. Finalize per-row `status` (`injected | in_context | not_injected |
 *      page_missing | corrupt`) on the caller-provided telemetry rows
 *      using the render result.
 *   5. Sort rows by `finalActivation` descending and flush the activation
 *      log — even when an error is thrown partway through, so silent
 *      failures remain observable.
 *   6. Return the rendered block plus `toInject = newlyInjected`.
 *
 * The caller pre-builds `telemetryRows` with all per-candidate breakdown
 * fields filled in (router-mode callers can pass zeros where the
 * breakdown doesn't apply) and a placeholder `status: "not_injected"`
 * which this helper overwrites. `nextStateMap` is the activation
 * pipeline's sparse next-state; router-mode callers pass an empty map.
 */
async function finalizeInjection(args: {
  workspaceDir: string;
  database: DrizzleDb;
  conversationId: string;
  mode: FinalizeInjectionMode;
  currentTurn: number;
  messageId: string;
  priorEverInjected: readonly EverInjectedEntry[];
  slugsToRender: string[];
  telemetryRows: MemoryV2ConceptRowRecord[];
  config: AssistantConfig;
  nextStateMap: Record<string, number>;
  /**
   * When true, errors thrown inside the helper (save / render / status
   * finalization) are logged and swallowed instead of re-thrown. Used by
   * the router-failure path, which is already a best-effort cleanup: a
   * transient SQLite write here must not abort the turn on top of the
   * router failure that already happened. Defaults to throwing.
   */
  bestEffort?: boolean;
}): Promise<InjectMemoryV2BlockResult> {
  const {
    workspaceDir,
    database,
    conversationId,
    currentTurn,
    messageId,
    priorEverInjected,
    slugsToRender,
    telemetryRows,
    config,
    nextStateMap,
  } = args;

  // `mode` is `let` because the trailing try/finally promotes it to "errored"
  // when the render/telemetry path throws — we still want a log row written
  // (with whatever rows we managed to build) so silent failures are
  // observable in the database.
  let mode: FinalizeInjectionMode = args.mode;

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
  // Synthetic slugs (skills, CLI commands) whose in-process cache entry is
  // missing (e.g. startup race between the seed and the first turn, or stale
  // Qdrant index pointing at an uninstalled skill / removed CLI command) are
  // excluded from `everInjected` so future per-turn runs re-attempt attachment
  // once the cache is populated. Without this, the slug would be marked
  // injected even though `renderInjectionBlock` silently dropped it.
  const missingSyntheticSlugs = new Set(
    slugsToRender.filter(
      (slug) =>
        (isSkillSlug(slug) && !getSkillCapability(slug)) ||
        (isCliCommandSlug(slug) && !getCliCommandCapability(slug)),
    ),
  );
  const everInjectedSet = new Set(priorEverInjected.map((entry) => entry.slug));
  const newlyInjected = slugsToRender.filter(
    (slug) => !everInjectedSet.has(slug) && !missingSyntheticSlugs.has(slug),
  );
  const nextEverInjected: EverInjectedEntry[] = [
    ...priorEverInjected,
    ...newlyInjected.map((slug) => ({ slug, turn: currentTurn })),
  ];

  const nextActivationState: ActivationState = {
    messageId,
    state: nextStateMap,
    everInjected: nextEverInjected,
    currentTurn,
    updatedAt: Date.now(),
  };

  // `block` and `conceptRowsForLog` are declared outside the try so the
  // finally block can flush activation telemetry even if rendering, status
  // finalization, or the activation-state save throws partway through.
  // Without this, a Zod failure on a single concept page (e.g. unrecognized
  // frontmatter key) silently dropped the entire turn's activation log row,
  // masking the underlying data-corruption bug.
  //
  // `conceptRowsForLog` only receives the caller-provided `telemetryRows`
  // *after* status finalization succeeds — matching the prior behavior where
  // an early `save()` / `renderInjectionBlock()` throw produced an empty
  // `concepts` array on the log row.
  let block: string | null = null;
  let conceptRowsForLog: MemoryV2ConceptRowRecord[] = [];
  let caughtErr: unknown = undefined;

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

    // Finalize per-row status onto the caller-provided telemetry rows.
    //   - context-load: cache was wiped (turn 1 / post-compaction), so
    //     `slugsToRender = topNow` and every rendered slug is freshly
    //     injected on this turn. `in_context` is unreachable because there
    //     is no prior cached attachment for the inspector to point at.
    //   - per-turn: cached attachments from prior turns are still on the
    //     user message, so prior-everInjected slugs are `in_context` and
    //     the delta (`slugsToRender`, which equals `toInject` in this mode)
    //     is `injected`.
    // `page_missing` and `corrupt` override any "would-have-been-injected"
    // status when `readPage` returned null or threw — telemetry surfaces
    // stale ANN/edge entries and malformed pages instead of silently
    // masquerading as successful injections. `corrupt` takes priority over
    // `page_missing` since they're mutually exclusive per slug.
    const renderedSet = new Set(slugsToRender);
    for (const row of telemetryRows) {
      const slug = row.slug;
      let status: MemoryV2ConceptRowRecord["status"];
      if (mode === "context-load") {
        status = renderedSet.has(slug) ? "injected" : "not_injected";
      } else if (everInjectedSet.has(slug)) {
        status = "in_context";
      } else if (renderedSet.has(slug)) {
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
      row.status = status;
    }
    telemetryRows.sort((a, b) => b.finalActivation - a.finalActivation);
    conceptRowsForLog = telemetryRows;
  } catch (err) {
    // Stash the error and let `finally` flush a best-effort telemetry row
    // before we re-throw to the caller. `mode = "errored"` flags the row
    // for observability dashboards / inspector queries. On the best-effort
    // path the error is logged and swallowed so the trailing return stands.
    caughtErr = err;
    mode = "errored";
    if (args.bestEffort) {
      log.warn(
        { err, conversationId, turn: currentTurn },
        "Memory v2 finalizeInjection error on best-effort path — swallowing",
      );
    }
  } finally {
    try {
      recordMemoryV2ActivationLog({
        conversationId,
        turn: currentTurn,
        mode,
        concepts: conceptRowsForLog,
        config: configSnapshot(config),
      });
    } catch (telemetryErr) {
      log.warn(
        { err: telemetryErr, conversationId, turn: currentTurn },
        "Failed to record memory v2 activation telemetry — continuing",
      );
    }
  }

  if (caughtErr !== undefined && !args.bestEffort) throw caughtErr;
  return { block, toInject: newlyInjected };
}

/**
 * Router-mode dispatch path. Replaces the spreading-activation pipeline with
 * a single LLM call that picks the per-turn concept-page set. On success we
 * reuse `finalizeInjection` so the persistence/render/telemetry contract
 * stays identical to the activation path; on `runRouter` failure we still
 * advance `activation_state` (so `currentTurn` and `messageId` move forward)
 * and emit a `mode: "errored"` telemetry row so the failure is observable.
 *
 * Failure rows are tagged `errored`, not `router`, because router-mode rows
 * are reserved for successful selections — keeping the two visually distinct
 * in inspector queries. `nextStateMap` is always empty in router mode: the
 * router does not compute spreading-activation scores, so there is no sparse
 * activation map to persist.
 */
async function injectViaRouter(args: {
  workspaceDir: string;
  database: DrizzleDb;
  conversationId: string;
  currentTurn: number;
  recentTurnPairs: readonly RouterTurnPair[];
  nowText: string;
  messageId: string;
  config: AssistantConfig;
  priorState: ActivationState | null;
  signal?: AbortSignal;
}): Promise<InjectMemoryV2BlockResult> {
  const {
    workspaceDir,
    database,
    conversationId,
    currentTurn,
    recentTurnPairs,
    nowText,
    messageId,
    config,
    priorState,
    signal,
  } = args;

  const priorEverInjected: readonly EverInjectedEntry[] =
    priorState?.everInjected ?? [];

  // Saturated-index bypass: when every page in the index has already been
  // injected on a prior turn of this conversation, the router LLM call is
  // provably useless — whatever it selected would be deduped against
  // `priorEverInjected` below and render nothing. Small workspaces reach
  // this state within the first few turns, after which the per-message
  // router call is pure cost. Skip the call and finalize directly with
  // carry-over telemetry, mirroring the success path's "all selections
  // already injected" outcome. (Trade-off: re-pick EMA events are not
  // recorded from this state; with the whole index attached, injection-
  // score ranking has nothing left to decide for this conversation.)
  const everInjectedSlugSet = new Set(priorEverInjected.map((e) => e.slug));
  const pageIndexForBypass = await getPageIndex(workspaceDir);
  if (
    pageIndexForBypass.entries.length > 0 &&
    pageIndexForBypass.entries.every((e) => everInjectedSlugSet.has(e.slug))
  ) {
    log.info(
      {
        conversationId,
        indexSize: pageIndexForBypass.entries.length,
      },
      "memory v2 router skipped — every index page already injected",
    );
    return finalizeInjection({
      workspaceDir,
      database,
      conversationId,
      mode: "router",
      currentTurn,
      messageId,
      priorEverInjected,
      slugsToRender: [],
      telemetryRows: priorEverInjected.map((entry) => ({
        slug: entry.slug,
        finalActivation: 0,
        ownActivation: 0,
        priorActivation: 0,
        simUser: 0,
        simAssistant: 0,
        simNow: 0,
        simUserRerankBoost: 0,
        simAssistantRerankBoost: 0,
        inRerankPool: false,
        spreadContribution: 0,
        source: "carry_over",
        status: "not_injected",
      })),
      config,
      nextStateMap: {},
    });
  }

  const routerResult = await runRouter({
    workspaceDir,
    recentTurnPairs,
    nowText,
    priorEverInjected,
    config,
    database,
    ...(signal ? { signal } : {}),
  });

  // Record router selections to the EMA event log. The router decided these
  // slugs are relevant THIS turn (regardless of whether they're newly
  // rendered or re-picked from prior context). The helper swallows its own
  // errors — a SQLite write must not abort the turn on top of a successful
  // routing decision the rest of this function depends on.
  if (routerResult.failureReason === null) {
    recordInjectionEvents(database, routerResult.selectedSlugs, Date.now());
  }

  if (routerResult.failureReason !== null) {
    log.warn(
      { failureReason: routerResult.failureReason },
      "memory v2 router failure; skipping injection",
    );
    // Delegate the failure path to `finalizeInjection` with empty inputs
    // and `mode: "errored"`. The helper persists a stub activation_state
    // (preserving `priorEverInjected` so future turns still subtract
    // previously-attached slugs) and writes the telemetry row through the
    // same code path as the success branch — no inline duplication of
    // `save` + `recordMemoryV2ActivationLog`. `bestEffort: true` matches
    // the pre-refactor inline behavior of logging and continuing if the
    // stub-state `save()` throws — we don't want a transient SQLite write
    // to abort the turn on top of the router failure that already happened.
    return finalizeInjection({
      workspaceDir,
      database,
      conversationId,
      mode: "errored",
      currentTurn,
      messageId,
      priorEverInjected,
      slugsToRender: [],
      telemetryRows: [],
      config,
      nextStateMap: {},
      bestEffort: true,
    });
  }

  // Dedupe router-picked slugs against `priorEverInjected` BEFORE rendering.
  // The router prompt explicitly invites the model to re-pick already-injected
  // pages "to re-anchor"; if we passed those through, `renderInjectionBlock`
  // would re-emit the slug into a fresh `<memory>` block while the prior
  // turn's cached attachment is still on the prior user message — duplicate
  // content. Activation per-turn mode does not have this issue because
  // `selectInjections()` returns `toInject = topNow - everInjected`.
  //
  // Telemetry rows for prior-everInjected slugs are still emitted below,
  // but tagged `source: "carry_over"` (not `"router"`) so inspector queries
  // can attribute selections correctly.
  const everInjectedSet = new Set(priorEverInjected.map((e) => e.slug));
  const slugsToRender = routerResult.selectedSlugs.filter(
    (s) => !everInjectedSet.has(s),
  );

  // Build minimal telemetry rows for the union of router-selected slugs and
  // prior `everInjected` slugs. Router-mode rows zero out every activation
  // value (no spreading activation runs). Slugs the router picked carry
  // their batch's tier tag from `routerResult.sourceBySlug` (e.g. `tier1`,
  // `tier3:2`); prior-everInjected slugs the router did NOT re-pick get
  // `source: "carry_over"`. The `status` placeholder is overwritten by
  // `finalizeInjection`.
  const telemetrySlugs = new Set<string>(routerResult.selectedSlugs);
  for (const entry of priorEverInjected) telemetrySlugs.add(entry.slug);
  const telemetryRows: MemoryV2ConceptRowRecord[] = [...telemetrySlugs].map(
    (slug) => ({
      slug,
      finalActivation: 0,
      ownActivation: 0,
      priorActivation: 0,
      simUser: 0,
      simAssistant: 0,
      simNow: 0,
      simUserRerankBoost: 0,
      simAssistantRerankBoost: 0,
      inRerankPool: false,
      spreadContribution: 0,
      source: routerResult.sourceBySlug.get(slug) ?? "carry_over",
      status: "not_injected",
    }),
  );

  return finalizeInjection({
    workspaceDir,
    database,
    conversationId,
    mode: "router",
    currentTurn,
    messageId,
    priorEverInjected,
    slugsToRender,
    telemetryRows,
    config,
    nextStateMap: {},
  });
}

/**
 * Snapshot the v2 config tunables in the shape `recordMemoryV2ActivationLog`
 * persists. Pulled out so the router-failure path does not duplicate the
 * field list inline.
 */
function configSnapshot(config: AssistantConfig) {
  const v2Cfg = config.memory.v2;
  return {
    d: v2Cfg.d,
    c_user: v2Cfg.c_user,
    c_assistant: v2Cfg.c_assistant,
    c_now: v2Cfg.c_now,
    k: v2Cfg.k,
    hops: v2Cfg.hops,
    top_k: v2Cfg.top_k,
    epsilon: v2Cfg.epsilon,
  };
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
 *
 * Exported for the v2-suppression regression tests: memory-v3's
 * `V3_CARDS_INJECTION_HEADER` is deliberately byte-identical to this header,
 * which is exactly why the v3-era tail strip must discriminate the two
 * `<memory>` layers by block identity rather than by this shared prefix.
 */
export const INJECTION_HEADER =
  'Use `file_read("memory/concepts/path/to/file.md")` to read the full pages for any of the injected memory summaries you want more information on.';

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
 * Skill and CLI-command slugs whose entry the in-process cache no longer
 * knows (e.g. uninstalled mid-run, or a CLI command removed between seeds)
 * are silently dropped, mirroring the missing-pages behavior but without
 * entering `missingSlugs` — the synthetic catalogs are the source of truth
 * for those entries, not on-disk concept pages.
 *
 * Each concept-page section is rendered as a path header followed by either
 * the page's `summary` (when present in frontmatter) or the full page (the
 * fallback for pages predating the summary field). Skills sit after the
 * concept sections under `### Skills You Can Use`, and CLI subcommands sit
 * after the skills under `### CLI Commands You Can Use`. The leading
 * instruction line tells the agent how to read the block.
 *
 *   Use `file_read("memory/concepts/path/to/file.md")` to read the full pages for any of the injected memory summaries you want more information on.
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
 *
 *   ### CLI Commands You Can Use
 *   Run `assistant <command> --help` for full usage.
 *   - `assistant <name-1>`: <description-1>
 *   - `assistant <name-2>`: <description-2>
 */
async function renderInjectionBlock(
  workspaceDir: string,
  slugs: string[],
): Promise<RenderInjectionBlockResult> {
  const conceptSlugs: string[] = [];
  const skillSlugs: string[] = [];
  const cliCommandSlugs: string[] = [];
  for (const slug of slugs) {
    if (isSkillSlug(slug)) skillSlugs.push(slug);
    else if (isCliCommandSlug(slug)) cliCommandSlugs.push(slug);
    else conceptSlugs.push(slug);
  }

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

  const cliCommandLines: string[] = [];
  for (const slug of cliCommandSlugs) {
    const entry = getCliCommandCapability(slug);
    if (!entry) continue;
    cliCommandLines.push(`- \`assistant ${entry.id}\`: ${entry.description}`);
  }
  if (cliCommandLines.length > 0) {
    sections.push(
      `### CLI Commands You Can Use\nRun \`assistant <command> --help\` for full usage.\n${cliCommandLines.join("\n")}`,
    );
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
