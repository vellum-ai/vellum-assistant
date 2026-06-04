/**
 * Default `memoryRetrieval` plugin.
 *
 * Encapsulates the three retrievals the agent loop performs before building
 * the runtime-injection block for a turn:
 *
 * 1. **PKB context** via {@link readPkbContext} — always-loaded workspace
 *    notes (INDEX.md, essentials.md, …) that precede the user's message.
 * 2. **NOW.md scratchpad** via {@link readNowScratchpad} — the short
 *    user-maintained note the assistant keeps up to date.
 * 3. **Memory graph** via {@link ConversationGraphMemory.prepareMemory} —
 *    dispatches to context-load or per-turn retrieval depending on
 *    initialization state; gated on the actor being trusted (guardian).
 *
 * The default plugin registers a pass-through middleware so the pipeline
 * runner always has at least one entry and downstream telemetry observes a
 * deterministic chain. The actual retrieval runs in the terminal supplied
 * by the agent loop; centralizing the helper here (as
 * {@link runDefaultMemoryRetrieval}) makes it trivial for a plugin to
 * fall back to the default behavior by calling this helper from its own
 * middleware.
 *
 * See `.private/plans/agent-plugin-system.md` PR 20 for the containing
 * milestone.
 */

import type { Logger } from "pino";

import type { AssistantConfig } from "../../../config/schema.js";
import {
  readNowScratchpad,
  readPkbContext,
} from "../../../daemon/conversation-runtime-assembly.js";
import type { ServerMessage } from "../../../daemon/message-protocol.js";
import type { MemoryRecalled } from "../../../daemon/message-types/memory.js";
import { updateMessageMetadata } from "../../../memory/conversation-crud.js";
import type { ConversationGraphMemory } from "../../../memory/graph/conversation-graph-memory.js";
import { recordMemoryRecallLog } from "../../../memory/memory-recall-log-store.js";
import type { Message } from "../../../providers/types.js";
import {
  type GraphMemoryResult,
  type MemoryArgs,
  type MemoryResult,
  type Plugin,
} from "../../types.js";
import defaultMemoryRetrievalMiddleware from "./middlewares/memoryRetrieval.js";
import pkg from "./package.json" with { type: "json" };

/**
 * External state the default retriever needs but the pipeline args cannot
 * carry (conversation-scoped graph handle, event sink, live message list).
 * Passed as a second argument to {@link runDefaultMemoryRetrieval} rather
 * than threaded through {@link MemoryArgs} to keep the plugin-facing
 * pipeline surface minimal.
 */
export interface DefaultMemoryRetrievalDeps {
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
}

/**
 * Persist and broadcast the retrieval's side effects: the injected block on
 * the user message's metadata (so it survives reloads), a recall-log row, and
 * the `memory_recalled` debug event. All three are best-effort — a failure to
 * persist must not abort the turn.
 */
function recordRecallSideEffects(
  graphResult: GraphMemoryResult,
  deps: DefaultMemoryRetrievalDeps,
): void {
  // Persist the injected block text in message metadata so it survives
  // conversation reloads (eviction, restart, fork). loadFromDb re-injects
  // from metadata.
  if (graphResult.injectedBlockText) {
    try {
      updateMessageMetadata(deps.userMessageId, {
        memoryInjectedBlock: graphResult.injectedBlockText,
      });
    } catch (err) {
      deps.logger.warn(
        { err },
        "Failed to persist memory injection to metadata (non-fatal)",
      );
    }
  }

  const m = graphResult.metrics;

  try {
    recordMemoryRecallLog({
      conversationId: deps.conversationId,
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
    deps.logger.warn(
      { err },
      "Failed to persist memory recall log (non-fatal)",
    );
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
    deps.onEvent(memoryRecalledEvent);
  }
}

/**
 * Run the default retrieval. Always returns a {@link MemoryResult}; skips
 * the memory-graph call entirely (returning a `null` `graphResult`) when the
 * actor is not trusted (matches the prior agent-loop gate).
 *
 * When the graph runs, this also persists its side effects — injected-block
 * metadata, the recall-log row, and the `memory_recalled` event — so callers
 * only consume the returned content and query vectors.
 *
 * Memory retrieval blocks the turn — there is no soft timeout here. Memory
 * is critical context, and silently dropping it produces a worse outcome
 * than a slower turn. Cancellation still works via `args.signal`, which is
 * threaded into `prepareMemory`.
 */
export async function runDefaultMemoryRetrieval(
  args: MemoryArgs,
  deps: DefaultMemoryRetrievalDeps,
): Promise<MemoryResult> {
  // NOW.md and PKB are read unconditionally — the agent loop decides
  // whether to inject them based on first-turn / post-compaction gating.
  const pkbContent = readPkbContext();
  const nowContent = readNowScratchpad();

  if (!deps.isTrustedActor) {
    // Untrusted actors skip memory-graph retrieval entirely — preserves the
    // pre-plugin gate that lived inline in `conversation-agent-loop.ts`.
    return {
      pkbContent,
      nowContent,
      graphResult: null,
    };
  }

  const graphResult = await deps.graphMemory.prepareMemory(
    deps.messages,
    deps.config,
    args.signal,
    deps.onEvent,
  );

  recordRecallSideEffects(graphResult, deps);

  return {
    pkbContent,
    nowContent,
    graphResult,
  };
}

/**
 * Default plugin exposing the `memoryRetrieval` pipeline slot. Registered
 * by {@link registerDefaultMemoryRetrievalPlugin} from the plugin
 * bootstrap wiring so ordering is deterministic across boots.
 */
export const defaultMemoryRetrievalPlugin: Plugin = {
  manifest: {
    name: pkg.name,
    version: pkg.version,
  },
  middleware: {
    memoryRetrieval: defaultMemoryRetrievalMiddleware,
  },
};
