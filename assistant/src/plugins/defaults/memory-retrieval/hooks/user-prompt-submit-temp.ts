/**
 * Default `user-prompt-submit-temp` hook: performs the three retrievals the
 * agent loop needs before building a turn's runtime-injection block.
 *
 * 1. **PKB context** via {@link readPkbContext} — always-loaded workspace
 *    notes (INDEX.md, essentials.md, …) that precede the user's message.
 * 2. **NOW.md scratchpad** via {@link readNowScratchpad} — the short
 *    user-maintained note the assistant keeps up to date.
 * 3. **Memory graph** via {@link ConversationGraphMemory.prepareMemory} —
 *    dispatches to context-load or per-turn retrieval depending on
 *    initialization state; gated on the actor being trusted (guardian).
 *
 * The hook also owns the retrieval's side effects — persisting the injected
 * block onto the user message's metadata, writing the recall log, and emitting
 * the `memory_recalled` event — so the loop only consumes the turn-scoped
 * outputs written back onto the context (`pkbContent`, `nowContent`,
 * `graphResult`).
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
import {
  readNowScratchpad,
  readPkbContext,
} from "../../../../daemon/conversation-runtime-assembly.js";
import type { ServerMessage } from "../../../../daemon/message-protocol.js";
import type { MemoryRecalled } from "../../../../daemon/message-types/memory.js";
import { updateMessageMetadata } from "../../../../memory/conversation-crud.js";
import type { ConversationGraphMemory } from "../../../../memory/graph/conversation-graph-memory.js";
import { recordMemoryRecallLog } from "../../../../memory/memory-recall-log-store.js";
import type { Message } from "../../../../providers/types.js";
import type { GraphMemoryResult } from "../../../types.js";

/**
 * Context threaded through the `user-prompt-submit-temp` hook. The input
 * fields carry the conversation-scoped state the retriever needs (graph
 * handle, event sink, live message list, abort signal); the output fields are
 * populated by the hook and read back by the agent loop.
 */
export interface MemoryRetrievalHookContext {
  /** Live message list for this turn (pre-injection). */
  readonly messages: Message[];
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
   * Trimmed PKB file contents ready for injection, or `null` when the file is
   * missing/empty. Written by the hook.
   */
  pkbContent: string | null;
  /**
   * Trimmed NOW.md contents ready for injection, or `null` when the file is
   * missing/empty. Written by the hook.
   */
  nowContent: string | null;
  /**
   * The memory-graph retrieval, or `null` when the actor is not trusted (the
   * graph call is skipped entirely in that case). Written by the hook.
   */
  graphResult: GraphMemoryResult | null;
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
 * Run the default retrieval, writing `pkbContent` / `nowContent` /
 * `graphResult` back onto the context. Skips the memory-graph call entirely
 * (leaving `graphResult` `null`) when the actor is not trusted.
 *
 * Memory retrieval blocks the turn — there is no soft timeout here. Memory is
 * critical context, and silently dropping it produces a worse outcome than a
 * slower turn. Cancellation still works via `ctx.signal`, which is threaded
 * into `prepareMemory`.
 */
const userPromptSubmitTemp: PluginHookFn<MemoryRetrievalHookContext> = async (
  ctx,
) => {
  // NOW.md and PKB are read unconditionally — the agent loop decides whether
  // to inject them based on first-turn / post-compaction gating.
  ctx.pkbContent = readPkbContext();
  ctx.nowContent = readNowScratchpad();

  if (!ctx.isTrustedActor) {
    // Untrusted actors skip memory-graph retrieval entirely.
    ctx.graphResult = null;
    return;
  }

  const graphResult = await ctx.graphMemory.prepareMemory(
    ctx.messages,
    ctx.config,
    ctx.signal,
    ctx.onEvent,
  );

  recordRecallSideEffects(graphResult, ctx);

  ctx.graphResult = graphResult;
};

export default userPromptSubmitTemp;
