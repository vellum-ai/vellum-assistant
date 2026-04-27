// ---------------------------------------------------------------------------
// Memory v2 — Per-turn injection block builder
// ---------------------------------------------------------------------------
//
// Drop-in replacement for v1's `injectMemoryBlock()` (graph/conversation-graph-memory.ts).
// Implements §5 of the design doc:
//
//   1. Hydrate prior activation state for the conversation.
//   2. Read edges.json (the topology source of truth).
//   3. Select the per-turn candidate set (prior-state survivors ∪ ANN top-K).
//   4. Compute own activation A_o over the candidates.
//   5. Apply 2-hop spreading activation with neighborhood normalization → A.
//   6. Pick top-K by activation; subtract everInjected to get the injection delta.
//   7. If no new slugs, render nothing — caller leaves the prior cached
//      attachments on prior user messages exactly as Anthropic prompt caching
//      requires.
//   8. Otherwise render a `<memory __injected>` block scoped to the *new* slugs
//      ordered by activation (descending) and persist the updated state +
//      everInjected list (with `currentTurn` annotated) so future turns can
//      append-inject cache-stably.
//
// Append-only on user messages: callers prepend `block` onto the *current*
// user message only — prior turns' attachments are left alone. This keeps the
// cached prefix bytes-identical across turns.

import type { AssistantConfig } from "../../config/types.js";
import { getWorkspaceDir } from "../../util/platform.js";
import type { DrizzleDb } from "../db-connection.js";
import {
  computeOwnActivation,
  selectCandidates,
  selectInjections,
  spreadActivation,
} from "./activation.js";
import { hydrate, save } from "./activation-store.js";
import { readEdges } from "./edges.js";
import { readPage } from "./page-store.js";
import type { ActivationState, EverInjectedEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Discriminator the wiring layer (`conversation-graph-memory.ts`) sets to
 * tell the v2 injector which call site is asking. Both modes currently share
 * the same block layout (mirroring v1 which also wraps both flows in
 * `<memory __injected>...</memory>`); the parameter exists so future tuning
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
   * Rendered `<memory __injected>` block, ready to prepend to the current
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

  // (2) Topology. `readEdges` returns the canonical empty index when the
  // file is missing (fresh workspace pre-consolidation).
  const edgesIdx = await readEdges(workspaceDir);

  // (3) Candidate set: prior-state survivors above epsilon ∪ ANN top-50.
  const candidates = await selectCandidates({
    priorState,
    userText: userMessage,
    assistantText: assistantMessage,
    nowText,
    config,
  });

  // (4) Own activation: A_o = d·prev + c_user·sim_u + c_a·sim_a + c_now·sim_n.
  const ownActivation = await computeOwnActivation({
    candidates,
    priorState,
    userText: userMessage,
    assistantText: assistantMessage,
    nowText,
    config,
  });

  // (5) Spreading activation across the edge graph (k, hops from config).
  const { k, hops, top_k, epsilon } = config.memory.v2;
  const finalActivation = spreadActivation(ownActivation, edgesIdx, k, hops);

  // (6) Pick top-K by activation; subtract everInjected for the injection delta.
  const priorEverInjected: readonly EverInjectedEntry[] =
    priorState?.everInjected ?? [];
  const { toInject } = selectInjections({
    A: finalActivation,
    priorEverInjected,
    topK: top_k,
  });

  // Build the next persisted state regardless of whether we render anything:
  // even on a "no new injection" turn, prior-state activations decay via the
  // candidate-set carry-forward and need to be rewritten so `epsilon`-trimmed
  // slugs drop out of consideration next turn.
  const nextState: Record<string, number> = {};
  for (const [slug, value] of finalActivation) {
    if (value > epsilon) nextState[slug] = value;
  }

  // Append the freshly injected slugs to everInjected (with their turn) so
  // future turns can subtract them. We append rather than reset so that
  // compaction-driven eviction (`evictCompactedTurns`) is the only path that
  // can re-enable a previously-injected slug.
  const nextEverInjected: EverInjectedEntry[] = [
    ...priorEverInjected,
    ...toInject.map((slug) => ({ slug, turn: currentTurn })),
  ];

  const nextActivationState: ActivationState = {
    messageId,
    state: nextState,
    everInjected: nextEverInjected,
    currentTurn,
    updatedAt: Date.now(),
  };

  await save(database, conversationId, nextActivationState);

  // (7) Cache-stable empty path: nothing new since the last turn.
  if (toInject.length === 0) {
    return { block: null, toInject: [] };
  }

  // (8) Render. `toInject` is already activation-descending (selectInjections
  // returns it as a filter of the sorted `topNow`), so it doubles as our
  // render order. Prior slugs sit unchanged on prior user messages.
  const block = await renderInjectionBlock(workspaceDir, toInject);

  return { block, toInject };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Render the `<memory __injected>` block for a list of slugs.
 *
 * Slugs are read in parallel via `readPage`. Pages whose file has gone
 * missing between selection and render (e.g. consolidation deleted them)
 * are silently dropped — the activation state still records them in
 * `everInjected` so we don't keep re-attempting on every turn.
 *
 * The block shape is the §5 layout from the design doc:
 *
 *   <memory __injected>
 *   ## What I Remember Right Now
 *   ### <slug-1>
 *   <body-1>
 *
 *   ### <slug-2>
 *   <body-2>
 *   </memory>
 *
 * Returns `null` when every requested slug is missing on disk so the caller
 * can fall through to its empty-block path instead of attaching a header
 * with no contents.
 */
async function renderInjectionBlock(
  workspaceDir: string,
  slugs: string[],
): Promise<string | null> {
  const pages = await Promise.all(
    slugs.map(async (slug) => {
      const page = await readPage(workspaceDir, slug);
      return page ? { slug, body: page.body.trim() } : null;
    }),
  );

  const sections: string[] = [];
  for (const entry of pages) {
    if (!entry || entry.body.length === 0) continue;
    sections.push(`### ${entry.slug}\n${entry.body}`);
  }
  if (sections.length === 0) return null;

  const inner = `## What I Remember Right Now\n\n${sections.join("\n\n")}`;
  return `<memory __injected>\n${inner}\n</memory>`;
}
