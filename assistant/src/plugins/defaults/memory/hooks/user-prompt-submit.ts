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
  HookFunction,
  UserPromptSubmitContext,
} from "@vellumai/plugin-api";
import { updateMessageMetadata } from "@vellumai/plugin-api";

import { getConfig } from "../../../../config/loader.js";
import { isMemoryV3Live } from "../../../../config/memory-v3-gate.js";
import { findConversationOrSubagent } from "../../../../daemon/conversation-registry.js";
import {
  applyRuntimeInjections,
  resolveTurnInboundActorContext,
  resolveTurnModelProfileLabel,
  type RuntimeInjectionResult,
} from "../../../../daemon/conversation-runtime-assembly.js";
import type { MemoryRecalled } from "../../../../daemon/message-types/memory.js";
import { resolveTrustClass } from "../../../../daemon/trust-context.js";
import { broadcastMessage } from "../../../../runtime/assistant-event-hub.js";
import type { GraphMemoryResult } from "../../../types.js";
import { recordMemoryRecallLog } from "../memory-recall-log-store.js";
import { MEMORY_V3_INJECTED_BLOCK_METADATA_KEY } from "../v3/ever-injected-store.js";

/**
 * Whether to run v2 graph-memory retrieval this turn. v2 retrieval is the
 * deprecated path: under `memory-v3-live`, v3 is the injected-memory source and
 * runtime assembly strips any v2 `<memory>` block, so running v2's retrieval
 * (embedding + hybrid search + the `memoryRetrieval` LLM router) only to
 * discard the result is pure per-turn waste. Untrusted actors never run it
 * either. The caller additionally requires the live conversation and its abort
 * signal to be present (kept inline at the call site for type narrowing).
 */
export function shouldRunV2Retrieval(params: {
  isTrustedActor: boolean;
  memoryV3Live: boolean;
}): boolean {
  return params.isTrustedActor && !params.memoryV3Live;
}

/**
 * Persist and broadcast the retrieval's side effects: the injected block on
 * the user message's metadata (so it survives reloads), a recall-log row, and
 * the `memory_recalled` debug event. All three are best-effort — a failure
 * must not abort the turn.
 *
 * The injected-block persist runs HERE, immediately after retrieval — not
 * after runtime assembly. v2's activation store marks the block's pages
 * `everInjected` during retrieval, so deferring the metadata write would open
 * a window (which includes memory-v3's selector LLM call when the shadow flag
 * is on) where a crash/abort leaves pages claimed-but-never-persisted: absent
 * from history on reload AND suppressed until compaction. When memory-v3
 * supersedes (strips) the block later this turn, {@link
 * persistInjectionBlocks} REMOVES this key again in its combined update — a
 * transient both-keys state mid-turn is acceptable; a v2 loss window is not.
 */
async function recordRecallSideEffects(
  graphResult: GraphMemoryResult,
  ctx: UserPromptSubmitContext,
): Promise<void> {
  if (graphResult.injectedBlockText) {
    try {
      await updateMessageMetadata(ctx.userMessageId, {
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
 * The two `<memory>` layers end the turn mutually exclusive per row:
 *  - v2's block (`memoryInjectedBlock`) was already persisted right after
 *    retrieval (see {@link recordRecallSideEffects} — no loss window). When
 *    memory-v3 superseded it this turn (`blocks.memoryV3Active`), assembly
 *    stripped the v2 block from the tail, so this combined update REMOVES the
 *    key again (persisting it would rehydrate a block that is not in the live
 *    history — a reload cache-bust and duplicated memory). `v2BlockPersisted`
 *    tells this function whether there is anything to remove.
 *  - `blocks.memoryV3InjectedBlock` (the frozen net-new card block, unwrapped)
 *    persists under `MEMORY_V3_INJECTED_BLOCK_METADATA_KEY`; `loadFromDb`
 *    re-wraps and splices it on load, freezing the cards into history.
 */
async function persistInjectionBlocks(
  blocks: RuntimeInjectionResult["blocks"],
  ctx: UserPromptSubmitContext,
  v2BlockPersisted: boolean,
): Promise<void> {
  const removeV2Block = Boolean(blocks.memoryV3Active) && v2BlockPersisted;
  if (
    !blocks.unifiedTurnContext &&
    !blocks.pkbSystemReminder &&
    !blocks.workspaceBlock &&
    !blocks.nowScratchpadBlock &&
    !blocks.pkbContextBlock &&
    !blocks.memoryV2StaticBlock &&
    !blocks.memoryV3InjectedBlock &&
    !blocks.backgroundTurnBlock &&
    !blocks.channelCapabilitiesBlock &&
    !blocks.nonInteractiveContextBlock &&
    !removeV2Block
  ) {
    return;
  }
  try {
    const metadataUpdates: Record<string, unknown> = {};
    if (removeV2Block) {
      // An explicit `undefined` overrides the value persisted after retrieval
      // and is dropped by `updateMessageMetadata`'s JSON.stringify, deleting
      // the key — the metadata schema types the field `string | absent`, so
      // removal must drop the key rather than write null.
      metadataUpdates.memoryInjectedBlock = undefined;
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
    if (blocks.backgroundTurnBlock) {
      metadataUpdates.backgroundTurnBlock = blocks.backgroundTurnBlock;
    }
    if (blocks.channelCapabilitiesBlock) {
      metadataUpdates.channelCapabilitiesBlock =
        blocks.channelCapabilitiesBlock;
    }
    if (blocks.nonInteractiveContextBlock) {
      metadataUpdates.nonInteractiveContextBlock =
        blocks.nonInteractiveContextBlock;
    }
    await updateMessageMetadata(ctx.userMessageId, metadataUpdates);
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
const userPromptSubmitMemoryRetrieval: HookFunction<
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
  );

  // v2 graph retrieval is the deprecated path: `shouldRunV2Retrieval` skips it
  // under memory-v3-live (v3 owns the `<memory>` layer and assembly strips any
  // v2 block) and for untrusted actors. The `conversation && abortSignal`
  // presence checks stay inline so the block below narrows. NOTE: this removes
  // the v2 fallback — under v3-live, a v3 empty/failed selection yields no NEW
  // injected memory that turn (prior turns' frozen v3 cards still ride history).
  const memoryV3Live = isMemoryV3Live(config);
  let v2BlockPersisted = false;
  if (
    shouldRunV2Retrieval({ isTrustedActor, memoryV3Live }) &&
    conversation &&
    abortSignal
  ) {
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

    await recordRecallSideEffects(graphResult, ctx);
    // The v2 block is persisted inside `recordRecallSideEffects`. If
    // memory-v3 supersedes it later this turn, `persistInjectionBlocks`
    // removes the key in its combined post-assembly update.
    v2BlockPersisted = Boolean(graphResult.injectedBlockText);

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
  // (`isNonInteractive`). The `model_profile` label is rendered from the
  // turn-start notice key when the profile changed, using the call site
  // self-resolved from the live conversation. The unified `<turn_context>`
  // actor input is
  // self-resolved from the live conversation's trust context. This first-call
  // assembly always runs at `"full"` volume; overflow reduction only downgrades
  // the mode on later re-injection.
  const modelProfile = resolveTurnModelProfileLabel(
    conversation?.currentTurnModelProfileNoticeKey ?? null,
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
  await persistInjectionBlocks(injection.blocks, ctx, v2BlockPersisted);
};

export default userPromptSubmitMemoryRetrieval;
