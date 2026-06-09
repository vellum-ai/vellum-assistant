/**
 * Default `user-prompt-submit-temp` hook: prepares a turn's prompt before the
 * first provider call by running memory-graph retrieval and then applying the
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
 * This fires at the early "prompt submitted, before context assembly" moment,
 * ahead of the canonical late `user-prompt-submit` hook (history repair,
 * title), which normalizes the assembled history after the overflow-reduction
 * transform that runs between the two moments. The `-temp` suffix marks this as
 * a transitional staging point that folds into `user-prompt-submit` once
 * compaction is cleared from the gap between the two call sites.
 */

import type { PluginHookFn } from "@vellumai/plugin-api";
import type { Logger } from "pino";

import { getConfig } from "../../../../config/loader.js";
import type { Conversation } from "../../../../daemon/conversation.js";
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
import type { Message } from "../../../../providers/types.js";
import type { GraphMemoryResult } from "../../../types.js";

/**
 * Context threaded through the `user-prompt-submit-temp` hook. The
 * conversation-scoped retrieval state (graph handle, abort signal, trust
 * class, client event sink) is self-resolved from the live conversation by id;
 * the readonly fields here carry the turn-start injection snapshot, while
 * `latestMessages` straddles input and output — the loop seeds it with the
 * pre-injection array and the hook overwrites it with the injected result.
 */
export interface MemoryRetrievalHookContext {
  /** Conversation the turn belongs to — keys the recall-log row. */
  readonly conversationId: string;
  /** User message the injected memory block is persisted onto. */
  readonly userMessageId: string;
  /** Turn-scoped logger for non-fatal persistence warnings. */
  readonly logger: Logger;
  /**
   * Working message list for the turn. Seeded by the loop with the
   * pre-injection messages and consumed as the retrieval input; the hook
   * overwrites it with the fully injected result (the memory-graph block, when
   * the actor is trusted, plus the runtime injections). Read back by the loop.
   */
  latestMessages: Message[];
  /**
   * Stable ID for the current request, forwarded onto the injector turn
   * context. The one turn-identity field the live conversation can't recover.
   */
  readonly requestId: string | undefined;
  /**
   * Whether the in-flight turn has no human present to answer clarification
   * questions. Resolved once at turn start and threaded in so injection uses
   * the turn-start snapshot rather than live state that can flip mid-turn.
   */
  readonly isNonInteractive: boolean;
  /**
   * Active inference profile key to announce in this turn's context, or `null`
   * when the profile is unchanged since the one last delivered to the model.
   * The hook renders the `model_profile` label (and model id) from this key
   * via the workspace LLM config rather than receiving the rendered string.
   */
  readonly modelProfileKey: string | null;
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
  emitEvent: Conversation["sendToClient"],
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
    emitEvent(memoryRecalledEvent);
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
 */
function persistInjectionBlocks(
  blocks: RuntimeInjectionResult["blocks"],
  ctx: MemoryRetrievalHookContext,
): void {
  if (
    !blocks.unifiedTurnContext &&
    !blocks.pkbSystemReminder &&
    !blocks.workspaceBlock &&
    !blocks.nowScratchpadBlock &&
    !blocks.pkbContextBlock &&
    !blocks.memoryV2StaticBlock
  ) {
    return;
  }
  try {
    const metadataUpdates: Record<string, unknown> = {};
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
  MemoryRetrievalHookContext
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

  if (conversation && isTrustedActor && abortSignal) {
    // The turn's client event sink is the live conversation's `sendToClient`,
    // resolved here rather than threaded in. It is the same per-conversation
    // sink the loop would otherwise hand over: `broadcastMessage` for client
    // turns, the `subagent_event` envelope for subagents, the voice handler
    // for voice turns. Resolving it internally keeps any raw emission
    // capability off the public hook contract.
    const emitEvent = conversation.sendToClient;
    const graphResult = await conversation.graphMemory.prepareMemory(
      ctx.latestMessages,
      config,
      abortSignal,
      emitEvent,
    );

    recordRecallSideEffects(graphResult, ctx, emitEvent);

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
  persistInjectionBlocks(injection.blocks, ctx);
};

export default userPromptSubmitMemoryRetrieval;
