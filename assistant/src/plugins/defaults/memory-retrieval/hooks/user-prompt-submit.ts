/**
 * Default `user-prompt-submit` hook: prepares a turn's prompt before the first
 * provider call by running memory-graph retrieval and then applying the
 * runtime injections that assemble the turn.
 *
 * **Memory graph** via {@link ConversationGraphMemory.prepareMemory} —
 * dispatches to context-load or per-turn retrieval depending on initialization
 * state; gated on the actor being trusted (guardian). The hook owns the
 * retrieval's side effects — persisting the injected block onto the user
 * message's metadata, writing the recall log, and emitting the
 * `memory_recalled` event. The PKB query-vector pair is recorded on the
 * conversation's graph handle for the PKB-reminder injector to read back. PKB
 * context and NOW.md are sourced directly by their injectors (gated on block
 * presence), not produced here.
 *
 * **Runtime injection** via {@link applyRuntimeInjections} — runs for every
 * actor (not just trusted ones) on the retrieved history, assembling the Slack
 * chronological transcript, the unified `<turn_context>` block,
 * channel/voice/transport hints, and the NOW.md / PKB / memory-v2 / workspace
 * blocks, then persisting the assembled blocks onto the user message's metadata
 * so they survive reloads. This is the first-call counterpart of the
 * post-compaction hook, which re-applies the same injections after a mid-loop
 * compaction.
 *
 * Registered first in the `user-prompt-submit` chain, so it heads the chain
 * ahead of history repair and title generation: those later hooks see the
 * fully assembled, memory-injected history.
 */

import type {
  PluginHookFn,
  UserPromptSubmitContext,
} from "@vellumai/plugin-api";

import { getConfig } from "../../../../config/loader.js";
import { findConversationOrSubagent } from "../../../../daemon/conversation-registry.js";
import {
  applyRuntimeInjections,
  resolveTurnInboundActorContext,
  resolveTurnModelProfileLabel,
  type RuntimeInjectionResult,
} from "../../../../daemon/conversation-runtime-assembly.js";
import type { MemoryRecalled } from "../../../../daemon/message-types/memory.js";
import { resolveTrustClass } from "../../../../daemon/trust-context.js";
import { updateMessageMetadata } from "../../../../memory/conversation-crud.js";
import { recordMemoryRecallLog } from "../../../../memory/memory-recall-log-store.js";
import { broadcastMessage } from "../../../../runtime/assistant-event-hub.js";
import type { GraphMemoryResult } from "../../../types.js";
import { MEMORY_V3_INJECTED_BLOCK_METADATA_KEY } from "../../memory-v3-shadow/ever-injected-store.js";

/**
 * Record and broadcast the retrieval's observability side effects: a
 * recall-log row and the `memory_recalled` debug event. Both are best-effort —
 * a failure must not abort the turn. The injected-block METADATA persist moved
 * to {@link persistInjectionBlocks}: it runs after runtime assembly, which is
 * the first point where it is known whether memory-v3 superseded (stripped)
 * v2's block this turn.
 */
function recordRecallSideEffects(
  graphResult: GraphMemoryResult,
  ctx: UserPromptSubmitContext,
): void {
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
    broadcastMessage(memoryRecalledEvent);
  }
}

/**
 * Persist the assembled runtime-injection blocks onto the user message's
 * metadata so they survive conversation reloads (eviction, restart, fork) —
 * loadFromDb re-injects from metadata. Only this first-call site persists: the
 * mid-loop re-entry sites send identical bytes and their tail row may not
 * correspond to `userMessageId`. All present blocks are written in a single
 * update to avoid doubling SQLite SELECT+UPDATE work each turn. Best-effort — a
 * persistence failure must not abort the turn.
 *
 * The two `<memory>` layers are mutually exclusive per row:
 *  - `v2InjectedBlockText` (the graph retrieval's block) persists as
 *    `memoryInjectedBlock` ONLY when memory-v3 did not supersede it this turn
 *    (`blocks.memoryV3Active`) — assembly stripped a superseded v2 block from
 *    the tail, so persisting it would rehydrate a block that is not in the
 *    live history (a reload cache-bust and duplicated memory).
 *  - `blocks.memoryV3InjectedBlock` (the frozen net-new card block, unwrapped)
 *    persists under `MEMORY_V3_INJECTED_BLOCK_METADATA_KEY`; `loadFromDb`
 *    re-wraps and splices it on load, freezing the cards into history.
 */
function persistInjectionBlocks(
  blocks: RuntimeInjectionResult["blocks"],
  ctx: UserPromptSubmitContext,
  v2InjectedBlockText: string | null,
): void {
  const v2BlockToPersist = blocks.memoryV3Active ? null : v2InjectedBlockText;
  if (
    !blocks.unifiedTurnContext &&
    !blocks.pkbSystemReminder &&
    !blocks.workspaceBlock &&
    !blocks.nowScratchpadBlock &&
    !blocks.pkbContextBlock &&
    !blocks.memoryV2StaticBlock &&
    !blocks.memoryV3InjectedBlock &&
    !v2BlockToPersist
  ) {
    return;
  }
  try {
    const metadataUpdates: Record<string, unknown> = {};
    if (v2BlockToPersist) {
      metadataUpdates.memoryInjectedBlock = v2BlockToPersist;
    }
    if (blocks.memoryV3InjectedBlock) {
      metadataUpdates[MEMORY_V3_INJECTED_BLOCK_METADATA_KEY] =
        blocks.memoryV3InjectedBlock;
    }
    if (blocks.unifiedTurnContext) {
      metadataUpdates.turnContextBlock = blocks.unifiedTurnContext;
    }
    if (blocks.pkbSystemReminder) {
      metadataUpdates.pkbSystemReminderBlock = blocks.pkbSystemReminder;
    }
    if (blocks.workspaceBlock) {
      metadataUpdates.workspaceBlock = blocks.workspaceBlock;
    }
    if (blocks.nowScratchpadBlock) {
      metadataUpdates.nowScratchpadBlock = blocks.nowScratchpadBlock;
    }
    if (blocks.pkbContextBlock) {
      metadataUpdates.pkbContextBlock = blocks.pkbContextBlock;
    }
    if (blocks.memoryV2StaticBlock) {
      metadataUpdates.memoryV2StaticBlock = blocks.memoryV2StaticBlock;
    }
    updateMessageMetadata(ctx.userMessageId, metadataUpdates);
  } catch (err) {
    ctx.logger.warn(
      { err },
      "Failed to persist injection metadata (non-fatal)",
    );
  }
}

/**
 * Run the default retrieval and assemble the turn's prompt. Memory-graph
 * retrieval is gated on the actor being trusted (guardian); untrusted actors
 * skip it, leaving `latestMessages` as the seeded input. Runtime injection then
 * runs for every actor, writing the fully injected result back onto
 * `latestMessages` and persisting the assembled blocks.
 *
 * Memory retrieval blocks the turn — there is no soft timeout here. Memory is
 * critical context, and silently dropping it produces a worse outcome than a
 * slower turn. Cancellation still works via `ctx.signal`, which is threaded
 * into `prepareMemory`.
 */
const userPromptSubmitMemoryRetrieval: PluginHookFn<
  UserPromptSubmitContext
> = async (ctx) => {
  // The conversation-scoped retrieval state — graph handle, abort signal, and
  // trust class — is resolved from the live conversation by id rather than
  // threaded in, mirroring how `applyRuntimeInjections` self-resolves its
  // per-turn inputs.
  const conversation = findConversationOrSubagent(ctx.conversationId);
  const config = getConfig();
  const abortSignal = conversation?.abortController?.signal;
  const isTrustedActor =
    resolveTrustClass(conversation?.trustContext) === "guardian";
  const actorContext = resolveTurnInboundActorContext(
    conversation?.trustContext,
    conversation?.assistantId,
  );

  let v2InjectedBlockText: string | null = null;
  if (conversation && isTrustedActor && abortSignal) {
    // Retrieval progress (`memory_status`) and the `memory_recalled` summary
    // publish to the shared `broadcastMessage` hub — the sink every turn
    // publisher converges to — rather than a threaded event callback. This
    // keeps any raw client-emit capability off the hook contract.
    const graphResult = await conversation.graphMemory.prepareMemory(
      ctx.latestMessages,
      config,
      abortSignal,
      broadcastMessage,
    );

    recordRecallSideEffects(graphResult, ctx);
    // Held until after runtime assembly: whether this block persists to
    // metadata depends on whether memory-v3 supersedes it this turn (see
    // `persistInjectionBlocks`).
    v2InjectedBlockText = graphResult.injectedBlockText;

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
      conversation.graphMemory.recordPkbQueryVectors(
        graphResult.userQueryVector,
        graphResult.userQuerySparseVector,
      );
    } else {
      conversation.graphMemory.recordPkbQueryVectors(
        graphResult.queryVector,
        graphResult.sparseVector,
      );
    }
  }

  // Runtime injection assembles the turn's prompt onto the retrieved history.
  // It runs for every actor (untrusted actors skip only the memory-graph step
  // above). `applyRuntimeInjections` self-resolves every per-turn injection
  // input — the Slack chronological transcript, the unified `<turn_context>`
  // block, channel/voice/transport hints, and the turn's trust/index/call-site
  // — from the live conversation, so we hand in only the request id and
  // conversation id plus the field resolved once at turn start
  // (`isNonInteractive`). The `model_profile` label is rendered here from the
  // turn's resolved profile key, using the call site self-resolved from the
  // live conversation. The unified `<turn_context>` actor input is
  // self-resolved from the live conversation's trust context. This first-call
  // assembly always runs at `"full"` volume; overflow reduction only downgrades
  // the mode on later re-injection.
  const modelProfile = resolveTurnModelProfileLabel(
    ctx.modelProfileKey,
    conversation?.currentCallSite ?? "mainAgent",
    config.llm,
    ctx.conversationId,
  );
  const injection = await applyRuntimeInjections(ctx.latestMessages, {
    isNonInteractive: ctx.isNonInteractive,
    modelProfile,
    actorContext,
    mode: "full",
    requestId: ctx.requestId,
    conversationId: ctx.conversationId,
  });
  ctx.latestMessages = injection.messages;
  persistInjectionBlocks(injection.blocks, ctx, v2InjectedBlockText);
};

export default userPromptSubmitMemoryRetrieval;
