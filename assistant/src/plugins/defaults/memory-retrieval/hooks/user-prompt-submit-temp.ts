/**
 * Default `user-prompt-submit-temp` hook: runs the memory-graph retrieval the
 * agent loop needs before building a turn's runtime-injection block.
 *
 * **Memory graph** via {@link ConversationGraphMemory.prepareMemory} —
 * dispatches to context-load or per-turn retrieval depending on initialization
 * state; gated on the actor being trusted (guardian).
 *
 * The hook also owns the retrieval's side effects — persisting the injected
 * block onto the user message's metadata, writing the recall log, and emitting
 * the `memory_recalled` event — so the loop only consumes the turn-scoped
 * `latestMessages` written back onto the context. The PKB query-vector pair is
 * recorded on the conversation's graph handle for the PKB-reminder injector to
 * read back. PKB context and NOW.md are sourced directly by their injectors
 * (gated on block presence), not produced here.
 *
 * This fires at the early "prompt submitted, before context assembly" moment,
 * distinct from the canonical late `user-prompt-submit` hook (history repair,
 * title): memory's outputs feed the injection and overflow-reduction transforms
 * that run between the two moments. The `-temp` suffix marks this as a
 * transitional staging point that folds into `user-prompt-submit` once
 * compaction is cleared from the gap between the two call sites.
 */

import type { PluginHookFn } from "@vellumai/plugin-api";
import type { Logger } from "pino";

import type { AssistantConfig } from "../../../../config/schema.js";
import type { ServerMessage } from "../../../../daemon/message-protocol.js";
import type { MemoryRecalled } from "../../../../daemon/message-types/memory.js";
import { updateMessageMetadata } from "../../../../memory/conversation-crud.js";
import type { ConversationGraphMemory } from "../../../../memory/graph/conversation-graph-memory.js";
import { recordMemoryRecallLog } from "../../../../memory/memory-recall-log-store.js";
import type { Message } from "../../../../providers/types.js";
import type { GraphMemoryResult } from "../../../types.js";

/**
 * Context threaded through the `user-prompt-submit-temp` hook. The readonly
 * fields carry the conversation-scoped state the retriever needs (graph
 * handle, event sink, abort signal); the output fields are populated by the
 * hook and read back by the agent loop. `latestMessages` straddles both: the
 * loop seeds it with the pre-injection array and the hook overwrites it with
 * the injected result.
 */
export interface MemoryRetrievalHookContext {
  /** Per-conversation memory graph handle. */
  readonly graphMemory: ConversationGraphMemory;
  /** Assistant config snapshot. */
  readonly config: AssistantConfig;
  /** Event sink used by the graph retriever and `memory_recalled` emission. */
  readonly onEvent: (msg: ServerMessage) => void;
  /** True when the actor for this turn is trusted (guardian-class). */
  readonly isTrustedActor: boolean;
  /** Conversation the turn belongs to — keys the recall-log row. */
  readonly conversationId: string;
  /** User message the injected memory block is persisted onto. */
  readonly userMessageId: string;
  /** Turn-scoped logger for non-fatal persistence warnings. */
  readonly logger: Logger;
  /**
   * Per-turn abort signal forwarded to `prepareMemory`. An external cancel
   * aborts the underlying retrieval instead of letting it run to completion.
   */
  readonly signal: AbortSignal;
  /**
   * Working message list for the turn. Seeded by the loop with the
   * pre-injection messages and consumed as the retrieval input; the hook
   * overwrites it with the memory-graph block injected, or leaves it
   * unchanged when no graph retrieval ran (untrusted actor, or a no-op
   * retrieval). Read back by the loop.
   */
  latestMessages: Message[];
}

/**
 * Persist and broadcast the retrieval's side effects: the injected block on
 * the user message's metadata (so it survives reloads), a recall-log row, and
 * the `memory_recalled` debug event. All three are best-effort — a failure to
 * persist must not abort the turn.
 */
function recordRecallSideEffects(
  graphResult: GraphMemoryResult,
  ctx: MemoryRetrievalHookContext,
): void {
  // Persist the injected block text in message metadata so it survives
  // conversation reloads (eviction, restart, fork). loadFromDb re-injects
  // from metadata.
  if (graphResult.injectedBlockText) {
    try {
      updateMessageMetadata(ctx.userMessageId, {
        memoryInjectedBlock: graphResult.injectedBlockText,
      });
    } catch (err) {
      ctx.logger.warn(
        { err },
        "Failed to persist memory injection to metadata (non-fatal)",
      );
    }
  }

  const m = graphResult.metrics;

  try {
    recordMemoryRecallLog({
      conversationId: ctx.conversationId,
      enabled: true,
      degraded: false,
      provider: m?.embeddingProvider ?? undefined,
      model: m?.embeddingModel ?? undefined,
      semanticHits: m?.semanticHits ?? 0,
      mergedCount: m?.mergedCount ?? 0,
      selectedCount: m?.selectedCount ?? 0,
      tier1Count: m?.tier1Count ?? 0,
      tier2Count: m?.tier2Count ?? 0,
      hybridSearchLatencyMs: m?.hybridSearchLatencyMs ?? 0,
      sparseVectorUsed: m?.sparseVectorUsed ?? false,
      injectedTokens: graphResult.injectedTokens,
      latencyMs: graphResult.latencyMs,
      topCandidatesJson: (m?.topCandidates ?? []).map((c) => ({
        key: c.nodeId,
        type: c.type,
        kind: "graph",
        finalScore: c.score,
        semantic: c.semanticSimilarity,
        recency: c.recencyBoost,
      })),
      injectedText: graphResult.injectedBlockText ?? undefined,
      reason: `graph:${graphResult.mode}`,
      queryContext: m?.queryContext ?? undefined,
    });
  } catch (err) {
    ctx.logger.warn({ err }, "Failed to persist memory recall log (non-fatal)");
  }

  if (m) {
    const memoryRecalledEvent: MemoryRecalled = {
      type: "memory_recalled",
      provider: m.embeddingProvider ?? "unknown",
      model: m.embeddingModel ?? "unknown",
      semanticHits: m.semanticHits,
      mergedCount: m.mergedCount,
      selectedCount: m.selectedCount,
      tier1Count: m.tier1Count,
      tier2Count: m.tier2Count,
      hybridSearchLatencyMs: m.hybridSearchLatencyMs,
      sparseVectorUsed: m.sparseVectorUsed,
      injectedTokens: graphResult.injectedTokens,
      latencyMs: graphResult.latencyMs,
      topCandidates: m.topCandidates.map((c) => ({
        key: c.nodeId,
        type: c.type,
        kind: "graph",
        finalScore: c.score,
        semantic: c.semanticSimilarity,
        recency: c.recencyBoost,
      })),
    };
    ctx.onEvent(memoryRecalledEvent);
  }
}

/**
 * Run the default retrieval, writing `latestMessages` back onto the context and
 * recording the PKB query-vector pair on the graph handle. Skips the
 * memory-graph call entirely (leaving `latestMessages` as the seeded input
 * messages and no query pair recorded) when the actor is not trusted.
 *
 * Memory retrieval blocks the turn — there is no soft timeout here. Memory is
 * critical context, and silently dropping it produces a worse outcome than a
 * slower turn. Cancellation still works via `ctx.signal`, which is threaded
 * into `prepareMemory`.
 */
const userPromptSubmitMemoryRetrieval: PluginHookFn<
  MemoryRetrievalHookContext
> = async (ctx) => {
  if (!ctx.isTrustedActor) {
    // Untrusted actors skip memory-graph retrieval entirely.
    return;
  }

  const graphResult = await ctx.graphMemory.prepareMemory(
    ctx.latestMessages,
    ctx.config,
    ctx.signal,
    ctx.onEvent,
  );

  recordRecallSideEffects(graphResult, ctx);

  ctx.latestMessages = graphResult.runMessages;
  // Select dense+sparse as a matched pair so RRF fusion combines two signals
  // aligned to the same query text:
  //   1. Context-load with a user query: user-query dense + user-query sparse
  //      — the cleanest pairing.
  //   2. Otherwise (context-load without a user query, or per-turn): whatever
  //      `queryVector` / `sparseVector` the retriever produced, which are
  //      themselves co-aligned (both summary-derived in context-load, both
  //      user-last-message-derived in per-turn).
  // Never pair a user-query dense with a summary-aligned sparse.
  // The PKB-reminder injector reads this pair back off the same graph handle
  // (looked up by conversation id) rather than receiving it threaded through
  // the agent loop.
  if (graphResult.userQueryVector) {
    ctx.graphMemory.recordPkbQueryVectors(
      graphResult.userQueryVector,
      graphResult.userQuerySparseVector,
    );
  } else {
    ctx.graphMemory.recordPkbQueryVectors(
      graphResult.queryVector,
      graphResult.sparseVector,
    );
  }
};

export default userPromptSubmitMemoryRetrieval;
