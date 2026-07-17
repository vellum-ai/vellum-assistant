// ---------------------------------------------------------------------------
// Memory Graph — Conversation-level memory integration
//
// Replaces the old `prepareMemoryContext` from conversation-memory.ts.
// Manages the InContextTracker lifecycle and dispatches to the correct
// retrieval mode based on conversation state.
// ---------------------------------------------------------------------------

import type { ContentBlock, ImageContent, Message } from "@vellumai/plugin-api";
import { and, desc, eq, inArray, ne, notInArray } from "drizzle-orm";
import { z } from "zod";

import type { AssistantConfig } from "../../../../config/types.js";
import { estimateTextTokens } from "../../../../context/token-estimator.js";
import type { ServerMessage } from "../../../../daemon/message-protocol.js";
import { getDb } from "../../../../persistence/db-connection.js";
import { embedWithRetry } from "../../../../persistence/embeddings/embed.js";
import { generateSparseEmbedding } from "../../../../persistence/embeddings/embedding-backend.js";
import type { QdrantSparseVector } from "../../../../persistence/embeddings/qdrant-client.js";
import { conversations } from "../../../../persistence/schema/conversations.js";
import { memorySummaries } from "../../../../persistence/schema/index.js";
import { getLogger } from "../logging.js";
import { wrapMemoryBlock } from "../memory-marker.js";
import { getWorkspaceDir } from "../paths.js";
import {
  clearEverInjected as clearV2EverInjected,
  hydrate as hydrateV2State,
  save as saveV2State,
} from "../v2/activation-store.js";
import {
  injectMemoryV2Block,
  type InjectMemoryV2Mode,
} from "../v2/injection.js";
import { loadNowText } from "../v2/now-text.js";
import type { RouterTurnPair } from "../v2/router.js";
import { clearConversation as clearV3EverInjected } from "../v3/ever-injected-store.js";
import {
  loadGraphMemoryState,
  saveGraphMemoryState,
} from "./graph-memory-state-store.js";
import {
  assembleContextBlock,
  assembleInjectionBlock,
  InContextTracker,
  type InContextTrackerSnapshot,
  MAX_CONTEXT_LOAD_IMAGES,
  MAX_PER_TURN_IMAGES,
  type ResolvedImage,
  resolveInjectionImages,
} from "./injection.js";
import { loadContextMemory, retrieveForTurn } from "./retriever.js";
import type { RetrievalMetrics } from "./types.js";

const log = getLogger("graph-conversation-memory");

const ESTIMATED_IMAGE_TOKENS = 1000;

// ---------------------------------------------------------------------------
// Per-conversation state
// ---------------------------------------------------------------------------

/**
 * Registry of the live, per-conversation graph handles keyed by conversation
 * id. A handle registers itself on construction and removes itself on
 * {@link ConversationGraphMemory.dispose}, so memory-domain code that only
 * knows a conversation id (e.g. the post-compaction re-injection hook) can
 * reach the same in-memory handle the turn's retrieval used — its live
 * `tracker` / cached-node state, which a DB-reconstructed handle would not
 * carry. Not a general service locator: it holds only the graph handle, and
 * the daemon's `Conversation` remains the owner of the instance's lifecycle.
 */
const liveByConversation = new Map<string, ConversationGraphMemory>();

/**
 * Look up the live {@link ConversationGraphMemory} for a conversation, or
 * `undefined` when none is registered (no active conversation, or a context
 * with no conversation id). Returns the same instance the turn's retrieval
 * mutated, so cached-node re-tracking operates on real state.
 */
export function getLiveGraphMemory(
  conversationId: string | undefined,
): ConversationGraphMemory | undefined {
  if (!conversationId) return undefined;
  return liveByConversation.get(conversationId);
}

/**
 * Full output of a single memory-graph retrieval — the object returned by
 * {@link ConversationGraphMemory.prepareMemory} (injected messages, query
 * vectors, metrics). The plugin's user-prompt-submit hook consumes these
 * fields to drive PKB hint search and runtime injection.
 */
export type GraphMemoryResult = Awaited<
  ReturnType<ConversationGraphMemory["prepareMemory"]>
>;

/**
 * Manages memory graph state for a single conversation.
 * Create one per Conversation instance. Persists across turns.
 */
export class ConversationGraphMemory {
  readonly tracker = new InContextTracker();
  private initialized = false;
  private needsReload = false;
  private stateRestored = false;
  private conversationId: string;
  private lastInjectedBlock: string | null = null;
  private lastInjectedNodeIds: string[] = [];
  private lastInjectedImages: Map<string, ResolvedImage> = new Map();
  private lastPkbQueryVector: number[] | undefined;
  private lastPkbSparseVector: QdrantSparseVector | undefined;

  constructor(conversationId: string) {
    this.conversationId = conversationId;
    liveByConversation.set(conversationId, this);
  }

  /**
   * Remove this handle from the live registry. Called from
   * `Conversation.dispose`. Guards against clobbering a newer handle for the
   * same conversation (eviction + recreation) by only deleting the entry when
   * it still points at this instance.
   */
  dispose(): void {
    if (liveByConversation.get(this.conversationId) === this) {
      liveByConversation.delete(this.conversationId);
    }
  }

  /**
   * Persist tracker state to the database so it survives eviction.
   * Called during conversation disposal.
   */
  persistState(): void {
    if (!this.initialized) return;
    try {
      const snapshot: InContextTrackerSnapshot & {
        initialized: boolean;
        needsReload: boolean;
      } = {
        initialized: this.initialized,
        needsReload: this.needsReload,
        ...this.tracker.toJSON(),
      };
      saveGraphMemoryState(this.conversationId, JSON.stringify(snapshot));
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to persist graph memory state (non-fatal)",
      );
    }
  }

  /**
   * Restore tracker state from the database after eviction + recreation.
   * On failure or missing row, silently falls back to full context-load.
   */
  restoreState(): void {
    if (this.stateRestored) return;
    try {
      const json = loadGraphMemoryState(this.conversationId);
      if (!json) return;

      const snapshot = JSON.parse(json) as InContextTrackerSnapshot & {
        initialized: boolean;
        needsReload?: boolean;
      };
      this.initialized = snapshot.initialized;
      this.needsReload = snapshot.needsReload ?? false;
      this.tracker.restoreFrom(snapshot);
      this.stateRestored = true;

      log.info(
        {
          conversationId: this.conversationId,
          turn: snapshot.currentTurn,
          inContextCount: snapshot.inContext.length,
        },
        "Restored graph memory state after eviction",
      );
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to restore graph memory state — will do full context load",
      );
    }
  }

  /**
   * Fetch the most recent conversation summaries (excluding the current
   * conversation, which won't have one yet at context-load time).
   *
   * Prioritizes user conversations (conversationType != "background"),
   * allowing at most 1 background conversation summary so the retrieval
   * signal is mostly from direct interactions.
   *
   * Returns up to 3 summary texts, most recent first.
   */
  private fetchRecentSummaries(): string[] {
    try {
      const db = getDb();
      const baseWhere = and(
        eq(memorySummaries.scope, "conversation"),
        ne(memorySummaries.scopeKey, this.conversationId),
      );

      // Fetch user conversations first (up to 3)
      const userRows = db
        .select({ summary: memorySummaries.summary })
        .from(memorySummaries)
        .innerJoin(
          conversations,
          eq(memorySummaries.scopeKey, conversations.id),
        )
        .where(
          and(
            baseWhere,
            notInArray(conversations.conversationType, [
              "background",
              "scheduled",
            ]),
          ),
        )
        .orderBy(desc(memorySummaries.updatedAt))
        .limit(3)
        .all();

      if (userRows.length >= 3) {
        return userRows.map((r) => r.summary);
      }

      // Fill remaining slots with at most 1 background/scheduled conversation
      const remaining = Math.min(1, 3 - userRows.length);
      const bgRows = db
        .select({ summary: memorySummaries.summary })
        .from(memorySummaries)
        .innerJoin(
          conversations,
          eq(memorySummaries.scopeKey, conversations.id),
        )
        .where(
          and(
            baseWhere,
            inArray(conversations.conversationType, [
              "background",
              "scheduled",
            ]),
          ),
        )
        .orderBy(desc(memorySummaries.updatedAt))
        .limit(remaining)
        .all();

      return [...userRows, ...bgRows].map((r) => r.summary);
    } catch (err) {
      log.warn({ err }, "Failed to fetch recent conversation summaries");
      return [];
    }
  }

  /**
   * Notify that context compaction just happened.
   * On the next turn, we'll re-run full context load.
   */
  async onCompacted(compactedMessageCount: number): Promise<void> {
    // Evict everything — compaction summarized all prior turns.
    // The tracker can't know exactly which turns were compacted,
    // so we conservatively clear everything and reload.
    const upToTurn = this.tracker.getTurn();
    this.tracker.evictCompactedTurns(upToTurn);

    // Mirror the eviction on the v2 activation row: the cached `<memory>`
    // attachments those slugs lived on are gone, but `everInjected` would
    // otherwise keep them deduped from per-turn deltas forever.
    //
    // Cleared unconditionally rather than filtered by `upToTurn`: the
    // tracker's `currentTurn` is only persisted on graceful dispose while
    // `everInjected` is persisted every turn, so a SIGKILL'd session can
    // leave entries with `turn > tracker.currentTurn` that a turn-bounded
    // filter would skip.
    try {
      const db = getDb();
      const state = await hydrateV2State(db, this.conversationId);
      if (state) {
        await saveV2State(db, this.conversationId, clearV2EverInjected(state));
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to evict v2 activation state on compaction (non-fatal)",
      );
    }

    // Memory-v3's frozen-card dedup record resets at the same trigger: the
    // cached card blocks those slugs rode were just stripped by compaction, so
    // every slug must become re-injectable. Cleared unconditionally for the
    // same crash-drift reason as v2's `everInjected` above.
    try {
      clearV3EverInjected(this.conversationId);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to clear memory-v3 everInjected on compaction (non-fatal)",
      );
    }

    this.needsReload = true;
    log.info(
      { compactedMessageCount },
      "Compaction detected — will reload context on next turn",
    );
  }

  /**
   * Re-inject the most recent memory block after context compaction.
   * Synchronous — reuses the cached block from the last successful retrieval.
   * Does NOT advance turn count or run new retrieval.
   */
  reinjectCachedMemory(messages: Message[]): {
    runMessages: Message[];
    injectedTokens: number;
  } {
    if (!this.lastInjectedBlock) {
      return { runMessages: messages, injectedTokens: 0 };
    }
    // Re-track node IDs since onCompacted evicted them
    this.tracker.add(this.lastInjectedNodeIds);
    // Strip any existing <memory> blocks from the last user message
    // before re-injecting, so compaction sites don't end up with duplicates.
    const cleaned = stripExistingMemoryInjections(messages);

    const injectedTokens =
      estimateTextTokens(this.lastInjectedBlock) +
      this.lastInjectedImages.size * ESTIMATED_IMAGE_TOKENS;

    if (this.lastInjectedImages.size > 0) {
      return {
        runMessages: injectMemoryBlock(
          cleaned,
          this.lastInjectedBlock,
          this.lastInjectedImages,
        ),
        injectedTokens,
      };
    }

    return {
      runMessages: injectTextBlock(cleaned, this.lastInjectedBlock),
      injectedTokens,
    };
  }

  /**
   * Re-register cached node IDs with the InContextTracker after compaction
   * WITHOUT modifying messages. Use this at post-agent-loop compaction sites
   * where the memory block already survives on the original user message
   * (since `<memory>` is not stripped by stripInjectionsForCompaction).
   *
   * Calling reinjectCachedMemory at these sites would inject a duplicate
   * onto the last user message — which after tool calls is a tool_result,
   * not the original user message.
   */
  retrackCachedNodes(): void {
    if (this.lastInjectedNodeIds.length === 0) return;
    this.tracker.add(this.lastInjectedNodeIds);
  }

  /**
   * Record the dense/sparse query-vector pair this turn's retrieval produced
   * for PKB hybrid search. The PKB-reminder injector reuses the same
   * embedding (looked up by conversation id via {@link getLiveGraphMemory})
   * rather than receiving it threaded through the agent loop, so the vectors
   * stay owned by the memory domain that computes them.
   */
  recordPkbQueryVectors(
    dense: number[] | undefined,
    sparse: QdrantSparseVector | undefined,
  ): void {
    this.lastPkbQueryVector = dense;
    this.lastPkbSparseVector = sparse;
  }

  /** Dense PKB query vector from this turn's retrieval, or `undefined`. */
  get pkbQueryVector(): number[] | undefined {
    return this.lastPkbQueryVector;
  }

  /** Sparse PKB query vector paired with {@link pkbQueryVector}. */
  get pkbSparseVector(): QdrantSparseVector | undefined {
    return this.lastPkbSparseVector;
  }

  /**
   * The unwrapped text of the dynamic memory block the last retrieval
   * injected (the v2 router block, or the v1 context block on legacy
   * configs), or `null` when the last retrieval injected nothing.
   *
   * Runtime assembly reads this as the IDENTITY of the v2 dynamic `<memory>`
   * block when memory-v3 supersedes the v2 layer: v2's block and v3's frozen
   * card blocks deliberately share the same wrapper AND leading instruction
   * header bytes, so the tail strip must match the exact block this handle
   * prepended (`prepareMemory` → `injectTextBlock`, or a convergence
   * re-injection of the same cached text) rather than any shared prefix.
   */
  get lastInjectedBlockText(): string | null {
    return this.lastInjectedBlock;
  }

  /**
   * Main entry point — called on every turn before the LLM sees the messages.
   *
   * Dispatches to the appropriate retrieval mode:
   * - Turn 1 (or after compaction): full context load
   * - Every other turn: per-turn injection
   *
   * Returns augmented messages with memory context prepended to the last
   * user message, following the same injection pattern as the old system.
   */
  async prepareMemory(
    messages: Message[],
    config: AssistantConfig,
    abortSignal: AbortSignal,
    onEvent: (msg: ServerMessage) => void,
  ): Promise<{
    runMessages: Message[];
    injectedTokens: number;
    latencyMs: number;
    mode: "context-load" | "per-turn" | "none";
    /** The raw text content of the injected block (without XML wrapper), or null if nothing was injected. */
    injectedBlockText: string | null;
    /** Retrieval pipeline metrics (null for noop/error paths). */
    metrics: RetrievalMetrics | null;
    /**
     * Dense query vector computed from the retrieval query — recent summaries
     * for context-load, the last-exchange text for per-turn. Surfaced so
     * downstream callers (e.g. the PKB hint retriever in
     * `applyRuntimeInjections`) can reuse the same embedding for a second
     * Qdrant query without paying for another embedding call. `undefined`
     * when no text was embedded (image-only turn, empty queries) or the
     * embedding call failed (circuit breaker).
     */
    queryVector?: number[];
    /** Optional sparse vector accompanying `queryVector`. */
    sparseVector?: QdrantSparseVector;
    /**
     * Dense query vector aligned to the latest user message (PR 3). Surfaced
     * so callers (PKB hint search) can prefer it over the summary-based
     * `queryVector`. `undefined` on the per-turn path and when no user-aligned
     * embed was computed.
     */
    userQueryVector?: number[];
    /**
     * Sparse (TF-IDF) vector of the user's latest message. Paired with
     * `userQueryVector` by PKB hint search to run a hybrid dense+sparse
     * query. `undefined` on the per-turn path and when no user query was
     * available (empty message or embedding skipped).
     */
    userQuerySparseVector?: QdrantSparseVector;
  }> {
    this.tracker.advanceTurn();

    const noopResult = {
      runMessages: messages,
      injectedTokens: 0,
      latencyMs: 0,
      mode: "none" as const,
      injectedBlockText: null as string | null,
      metrics: null as RetrievalMetrics | null,
    };

    if (config.memory.enabled === false) {
      // Clear any cached injection so a later overflow-reduction
      // re-injection via `reinjectCachedMemory()` cannot reintroduce a
      // stale <memory> block after the user disables memory.
      this.lastInjectedBlock = null;
      this.lastInjectedNodeIds = [];
      this.lastInjectedImages = new Map();
      return noopResult;
    }

    // Gate: skip for empty/tool-result-only messages — unless we need to
    // reload after compaction (needsReload) or haven't initialized yet.
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== "user") return noopResult;
    const hasUserContent = lastMessage.content.some(
      (block) => block.type === "text" && block.text.trim().length > 0,
    );
    if (!hasUserContent && this.initialized && !this.needsReload)
      return noopResult;

    try {
      // Decide which retrieval mode to use
      if (!this.initialized || this.needsReload) {
        const recentSummaries = this.fetchRecentSummaries();
        const firstUserText = extractUserText(lastMessage);

        return await this.runContextLoad(
          messages,
          config,
          recentSummaries,
          firstUserText ?? undefined,
          abortSignal,
          onEvent,
        );
      }

      return await this.runPerTurn(messages, config, abortSignal);
    } catch (err) {
      const errCode =
        err instanceof z.ZodError ? err.issues[0]?.code : undefined;
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          conversationId: this.conversationId,
          turn: this.tracker.getTurn(),
          errCode,
        },
        "Memory retrieval failed (non-fatal)",
      );
      return noopResult;
    }
  }

  // ---------------------------------------------------------------------------
  // Retrieval modes
  // ---------------------------------------------------------------------------

  private async runContextLoad(
    messages: Message[],
    config: AssistantConfig,
    recentSummaries: string[],
    userQuery: string | undefined,
    signal: AbortSignal,
    onEvent: (msg: ServerMessage) => void,
  ) {
    // Use the raw user text (no >10-char filter) so even short greetings
    // ("hi") get a fresh top-K activation dump on the first user message.
    // The activation pipeline is robust to weak ANN signal — it falls back
    // to spreading + nowText to surface candidates.
    const startedAt = Date.now();
    const rawUserText = readRawUserText(messages[messages.length - 1]);
    const v2 = await this.maybeRouteV2Injection(
      messages,
      config,
      "context-load",
      // Context-load runs before the messages array necessarily contains
      // the just-arrived user turn (post-compaction restore, turn 1
      // sketch), so override with the resolved user text rather than
      // walking back through `messages`.
      rawUserText ?? userQuery ?? "",
      signal,
    );

    if (v2.routed) {
      // Surface a user-query embedding so PKB hint search still runs on v2
      // turns. v1's `loadContextMemory` produced these as a side effect of
      // hybrid retrieval; the v2 path skips that retrieval, so embed
      // explicitly here.
      const userQueryText = rawUserText ?? userQuery ?? "";
      const userQueryEmbed = await this.computeQueryVectors(
        userQueryText,
        userQueryText,
        config,
        signal,
      );
      this.initialized = true;
      this.needsReload = false;
      this.lastInjectedBlock = v2.injectedBlockText;
      this.lastInjectedNodeIds = [];
      this.lastInjectedImages = new Map();
      return {
        runMessages: v2.runMessages,
        injectedTokens: v2.injectedBlockText
          ? estimateTextTokens(v2.injectedBlockText)
          : 0,
        latencyMs: Date.now() - startedAt,
        mode: "context-load" as const,
        injectedBlockText: v2.injectedBlockText,
        metrics: null,
        userQueryVector: userQueryEmbed.dense,
        userQuerySparseVector: userQueryEmbed.sparse,
      };
    }

    // v1 fallback — only reached when the v2 flag or workspace config is off.
    const result = await loadContextMemory({
      recentSummaries,
      userQuery,
      config,
      signal,
    });
    // Set initialized only after v1 retrieval succeeds. If `loadContextMemory`
    // throws (transient DB/Qdrant failure), `prepareMemory` catches and
    // returns noop, but we want the next turn to retry the bootstrap path
    // rather than be stuck in per-turn mode.
    this.initialized = true;
    this.needsReload = false;

    if (result.nodes.length === 0) {
      this.lastInjectedBlock = null;
      this.lastInjectedNodeIds = [];
      this.lastInjectedImages = new Map();
      return {
        runMessages: messages,
        injectedTokens: 0,
        latencyMs: result.latencyMs,
        mode: "context-load" as const,
        injectedBlockText: null,
        metrics: result.metrics,
        queryVector: result.queryVector,
        sparseVector: result.sparseVector,
        userQueryVector: result.userQueryVector,
        userQuerySparseVector: result.userQuerySparseVector,
      };
    }

    // Track loaded nodes (including serendipity)
    this.tracker.add(result.nodes.map((n) => n.node.id));
    this.tracker.add(result.serendipityNodes.map((n) => n.node.id));

    // Assemble context block
    const contextBlock = assembleContextBlock(result.nodes, {
      serendipityNodes: result.serendipityNodes,
    });
    if (!contextBlock) {
      return {
        runMessages: messages,
        injectedTokens: 0,
        latencyMs: result.latencyMs,
        mode: "context-load" as const,
        injectedBlockText: null,
        metrics: result.metrics,
        queryVector: result.queryVector,
        sparseVector: result.sparseVector,
        userQueryVector: result.userQueryVector,
        userQuerySparseVector: result.userQuerySparseVector,
      };
    }

    // Resolve images from scored nodes
    const images = await resolveInjectionImages(
      [...result.nodes, ...result.serendipityNodes],
      MAX_CONTEXT_LOAD_IMAGES,
    );

    const injectedTokens =
      estimateTextTokens(contextBlock) + images.size * ESTIMATED_IMAGE_TOKENS;

    onEvent({
      type: "memory_status",
      enabled: true,
      degraded: false,
    } as ServerMessage);

    this.lastInjectedBlock = contextBlock;
    this.lastInjectedNodeIds = [
      ...result.nodes.map((n) => n.node.id),
      ...result.serendipityNodes.map((n) => n.node.id),
    ];
    this.lastInjectedImages = images;

    return {
      runMessages: injectMemoryBlock(messages, contextBlock, images),
      injectedTokens,
      latencyMs: result.latencyMs,
      mode: "context-load" as const,
      injectedBlockText: contextBlock,
      metrics: result.metrics,
      queryVector: result.queryVector,
      sparseVector: result.sparseVector,
      userQueryVector: result.userQueryVector,
      userQuerySparseVector: result.userQuerySparseVector,
    };
  }

  private async runPerTurn(
    messages: Message[],
    config: AssistantConfig,
    signal: AbortSignal,
  ) {
    // Extract last assistant and user messages as text
    let assistantLast = "";
    let userLast = "";
    let userLastBlocks: ContentBlock[] = [];

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const text = msg.content
        .filter(
          (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
        )
        .map((b) => b.text)
        .join(" ");

      if (msg.role === "user") {
        if (userLastBlocks.length === 0) {
          userLastBlocks = msg.content;
          userLast = text;
        }
      } else if (msg.role === "assistant" && !assistantLast) {
        assistantLast = text;
      }
      if (userLastBlocks.length > 0 && assistantLast) break;
    }

    // v2 path — skip v1 retrieval entirely when v2 is enabled. See the
    // matching comment in `runContextLoad` for rationale.
    const startedAt = Date.now();
    const v2 = await this.maybeRouteV2Injection(
      messages,
      config,
      "per-turn",
      null,
      signal,
    );
    if (v2.routed) {
      // Surface a per-turn query embedding so PKB hint search still runs
      // on v2 turns. v1's `retrieveForTurn` produced these as a side effect;
      // the v2 path skips that retrieval, so embed explicitly here. Match
      // v1's split: dense embeds the combined assistant+user text (short
      // referential follow-ups like "do that one" need the assistant turn
      // for semantic grounding), while sparse uses the user message alone
      // to keep lexical signal focused on what the user actually said.
      const denseQueryText = [assistantLast, userLast]
        .filter((m) => m.length > 0)
        .join("\n\n");
      const perTurnEmbed = await this.computeQueryVectors(
        denseQueryText,
        userLast,
        config,
        signal,
      );
      this.lastInjectedBlock = v2.injectedBlockText;
      this.lastInjectedNodeIds = [];
      this.lastInjectedImages = new Map();
      return {
        runMessages: v2.runMessages,
        injectedTokens: v2.injectedBlockText
          ? estimateTextTokens(v2.injectedBlockText)
          : 0,
        latencyMs: Date.now() - startedAt,
        mode: "per-turn" as const,
        injectedBlockText: v2.injectedBlockText,
        metrics: null,
        queryVector: perTurnEmbed.dense,
        sparseVector: perTurnEmbed.sparse,
      };
    }

    // v1 path (only reached when the v2 flag or workspace config is off).
    const result = await retrieveForTurn({
      assistantLastMessage: assistantLast,
      userLastMessage: userLast,
      userLastMessageBlocks: userLastBlocks,
      config,
      tracker: this.tracker,
      signal,
    });

    if (result.nodes.length === 0) {
      this.lastInjectedBlock = null;
      this.lastInjectedNodeIds = [];
      this.lastInjectedImages = new Map();
      return {
        runMessages: messages,
        injectedTokens: 0,
        latencyMs: result.latencyMs,
        mode: "per-turn" as const,
        injectedBlockText: null,
        metrics: result.metrics,
        queryVector: result.queryVector,
        sparseVector: result.sparseVector,
      };
    }

    // Track new nodes
    this.tracker.add(result.nodes.map((n) => n.node.id));

    const injectionBlock = assembleInjectionBlock(result.nodes);
    if (!injectionBlock) {
      return {
        runMessages: messages,
        injectedTokens: 0,
        latencyMs: result.latencyMs,
        mode: "per-turn" as const,
        injectedBlockText: null,
        metrics: result.metrics,
        queryVector: result.queryVector,
        sparseVector: result.sparseVector,
      };
    }

    // Resolve images from scored nodes
    const images = await resolveInjectionImages(
      result.nodes,
      MAX_PER_TURN_IMAGES,
    );

    this.lastInjectedBlock = injectionBlock;
    this.lastInjectedNodeIds = result.nodes.map((n) => n.node.id);
    this.lastInjectedImages = images;

    return {
      runMessages: injectMemoryBlock(messages, injectionBlock, images),
      injectedTokens:
        estimateTextTokens(injectionBlock) +
        images.size * ESTIMATED_IMAGE_TOKENS,
      latencyMs: result.latencyMs,
      mode: "per-turn" as const,
      injectedBlockText: injectionBlock,
      metrics: result.metrics,
      queryVector: result.queryVector,
      sparseVector: result.sparseVector,
    };
  }

  /**
   * Embed a query string for PKB hint search on v2 turns. v1 retrieval
   * produced these vectors as a side effect; on v2 we skip retrieval, so
   * the agent loop loses the dense/sparse pair it needs to drive
   * `buildPkbReminderWithHints`. Failures here degrade PKB hints to the
   * static fallback rather than blocking the turn.
   */
  private async computeQueryVectors(
    denseText: string,
    sparseText: string,
    config: AssistantConfig,
    signal: AbortSignal,
  ): Promise<{ dense?: number[]; sparse?: QdrantSparseVector }> {
    const trimmedDense = denseText.trim();
    const trimmedSparse = sparseText.trim();
    let dense: number[] | undefined;
    if (trimmedDense.length > 0) {
      try {
        const result = await embedWithRetry(config, [trimmedDense], { signal });
        dense = result.vectors[0];
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "Failed to embed query for PKB hints on v2 path",
        );
      }
    }
    let sparse: QdrantSparseVector | undefined;
    if (trimmedSparse.length > 0) {
      const sparseRaw = generateSparseEmbedding(trimmedSparse);
      sparse = sparseRaw.indices.length > 0 ? sparseRaw : undefined;
    }
    return { dense, sparse };
  }

  /**
   * Run the v2 activation pipeline when the workspace config
   * (`memory.v2.enabled`) is on.
   *
   * The two outcomes the caller distinguishes via `routed`:
   *   - `routed: false` — v2 disabled; caller falls through to the legacy v1
   *                        retrieval path.
   *   - `routed: true`  — v2 ran. `runMessages` is either the v2-prepended
   *                        message list (block was non-null) or the input
   *                        messages unchanged (cache-stable empty path).
   *                        Caller does NOT fall through to v1 in either case.
   */
  private async maybeRouteV2Injection(
    messages: Message[],
    config: AssistantConfig,
    mode: InjectMemoryV2Mode,
    /**
     * Override for the just-arrived user message text. Used by
     * `runContextLoad` where the conversation history may not yet contain
     * the user message that triggered the load (e.g. turn 1 / post-
     * compaction restoration). When provided, the extracted pairs array
     * is replaced with `[{ assistantMessage: "", userMessage: override }]`.
     */
    userMessageOverride: string | null,
    signal: AbortSignal,
  ): Promise<{
    routed: boolean;
    runMessages: Message[];
    injectedBlockText: string | null;
  }> {
    if (!config.memory.v2.enabled) {
      return { routed: false, runMessages: messages, injectedBlockText: null };
    }

    const nowText = await loadNowText(getWorkspaceDir());
    const currentTurn = this.tracker.getTurn();
    const historicalPairs = config.memory.v2.router.historical_pairs;
    const recentTurnPairs =
      userMessageOverride !== null
        ? [{ assistantMessage: "", userMessage: userMessageOverride }]
        : extractRecentTurnPairs(messages, historicalPairs);

    const result = await injectMemoryV2Block({
      database: getDb(),
      conversationId: this.conversationId,
      currentTurn,
      recentTurnPairs,
      nowText,
      messageId: `${this.conversationId}:turn:${currentTurn}`,
      mode,
      config,
      signal,
    });

    if (!result.block) {
      return { routed: true, runMessages: messages, injectedBlockText: null };
    }

    return {
      routed: true,
      runMessages: injectTextBlock(messages, result.block),
      injectedBlockText: result.block,
    };
  }
}

// ---------------------------------------------------------------------------
// Injection helper — same pattern as old injectMemoryRecallAsUserBlock
// ---------------------------------------------------------------------------

/**
 * Count the leading content blocks on a user message that were added by
 * `injectMemoryBlock` or the `memory-v2-static` injector. Memory-injected
 * images use a 3-block pattern (opening `<memory_image>` text + image +
 * closing `</memory_image>` text), followed by a `<memory>…</memory>` text
 * block (legacy `<memory __injected>` is also accepted). The static
 * memory-v2 block uses `<info>…</info>` and is also counted here so that
 * `after-memory-prefix` splices for subsequent injectors (e.g. `now-md`)
 * land after both the dynamic and static blocks.
 *
 * The bare `<memory>` and `<info>` forms are matched only when the block
 * also ends with the corresponding closing tag, so user-authored content
 * that happens to begin with `<memory>` or `<info>` (for example, a
 * message discussing the XML-like markup) is not mistaken for an injected
 * prefix and stripped on re-injection. A legacy 2-block image pattern (no
 * closing tag) is also accepted for backward compatibility. The injection
 * prefix is always contiguous at the start, so we stop at the first
 * non-memory block.
 */
export function countMemoryPrefixBlocks(content: ContentBlock[]): number {
  let firstNonMemory = 0;
  let prevWasMemoryImageMarker = false;
  let prevWasInjectedImage = false;
  while (firstNonMemory < content.length) {
    const block = content[firstNonMemory];
    if (
      block.type === "text" &&
      ((block.text.startsWith("<memory>\n") &&
        block.text.endsWith("\n</memory>")) ||
        (block.text.startsWith("<info>\n") &&
          block.text.endsWith("\n</info>")) ||
        block.text.startsWith("<memory __injected>\n"))
    ) {
      firstNonMemory++;
      prevWasMemoryImageMarker = false;
      prevWasInjectedImage = false;
    } else if (
      block.type === "text" &&
      block.text.startsWith("<memory_image")
    ) {
      firstNonMemory++;
      prevWasMemoryImageMarker = true;
      prevWasInjectedImage = false;
    } else if (block.type === "image" && prevWasMemoryImageMarker) {
      firstNonMemory++;
      prevWasMemoryImageMarker = false;
      prevWasInjectedImage = true;
    } else if (
      block.type === "text" &&
      block.text === "</memory_image>" &&
      prevWasInjectedImage
    ) {
      firstNonMemory++;
      prevWasInjectedImage = false;
    } else {
      break;
    }
  }
  return firstNonMemory;
}

/**
 * Remove all memory-injected blocks from the last user message.
 *
 * `injectMemoryBlock` always prepends blocks in this order:
 *   1. For each image: `<memory_image __injected>…` text + `image` + `</memory_image>` text (3-block group)
 *   2. `<memory>…</memory>` text block
 *
 * We strip all leading blocks that match this pattern so that
 * `reinjectCachedMemory` is idempotent — no duplicate images after compaction.
 */
export function stripExistingMemoryInjections(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return messages;

  const stripped = stripMemoryPrefixFromUserMessage(last);
  if (stripped === last) return messages;

  return [...messages.slice(0, -1), stripped];
}

/**
 * Strip the memory-injected prefix from a single user message. Returns the
 * same message reference unchanged when it is not a user message or carries no
 * injected prefix, so callers can cheaply detect no-ops. Used by
 * `stripExistingMemoryInjections` (last message only) — memory-v3's frozen
 * card carry means historical `<memory>` blocks are never bulk-stripped
 * anymore (the old whole-layer `stripAllMemoryInjections` is gone): runtime
 * assembly strips only the TAIL's fresh v2 prefix when v3 supersedes it.
 */
function stripMemoryPrefixFromUserMessage(message: Message): Message {
  if (message.role !== "user") return message;
  const firstNonMemory = countMemoryPrefixBlocks(message.content);
  if (firstNonMemory === 0) return message;
  return { ...message, content: message.content.slice(firstNonMemory) };
}

/**
 * Return the memory-injected prefix blocks from the last user message, or
 * an empty array when there is none. Used by runtime assembly to carry the
 * memory block through transcript replacements (e.g. Slack chronological
 * rendering) that otherwise discard the prepended content.
 */
export function extractMemoryPrefixBlocks(messages: Message[]): ContentBlock[] {
  if (messages.length === 0) return [];
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return [];
  const count = countMemoryPrefixBlocks(last.content);
  return count === 0 ? [] : last.content.slice(0, count);
}

function injectTextBlock(messages: Message[], text: string): Message[] {
  if (text.trim().length === 0) return messages;
  if (messages.length === 0) return messages;
  // Strip existing memory blocks from the last user message first to prevent
  // duplicates when the message was loaded from DB with a persisted block.
  const cleaned = stripExistingMemoryInjections(messages);
  const userTail = cleaned[cleaned.length - 1];
  if (!userTail || userTail.role !== "user") return messages;
  return [
    ...cleaned.slice(0, -1),
    {
      ...userTail,
      content: [
        {
          type: "text" as const,
          text: wrapMemoryBlock(text),
        },
        ...userTail.content,
      ],
    },
  ];
}

function injectMemoryBlock(
  messages: Message[],
  text: string,
  images: Map<string, ResolvedImage>,
): Message[] {
  if (text.trim().length === 0 && images.size === 0) return messages;
  if (messages.length === 0) return messages;
  // Strip existing memory blocks from the last user message first to prevent
  // duplicates when the message was loaded from DB with a persisted block.
  const cleaned = stripExistingMemoryInjections(messages);
  const userTail = cleaned[cleaned.length - 1];
  if (!userTail || userTail.role !== "user") return messages;

  const blocks: ContentBlock[] = [];

  for (const [_nodeId, img] of images) {
    blocks.push({
      type: "text" as const,
      text: `<memory_image __injected>\n${img.description}`,
    });
    blocks.push({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: img.mediaType,
        data: img.base64Data,
      },
    } as ImageContent);
    blocks.push({
      type: "text" as const,
      text: `</memory_image>`,
    });
  }

  blocks.push({
    type: "text" as const,
    text: wrapMemoryBlock(text),
  });

  return [
    ...cleaned.slice(0, -1),
    { ...userTail, content: [...blocks, ...userTail.content] },
  ];
}

/**
 * Extract text content from a user message for v1's `loadContextMemory`,
 * skipping very short messages because v1's path embeds a single dense
 * vector and short queries produce vague results.
 */
function extractUserText(message: Message): string | null {
  const joined = readRawUserText(message);
  if (!joined) return null;
  return joined.length > 10 ? joined : null;
}

/**
 * Raw user-text reader (no length filter). The v2 activation pipeline can
 * use even short queries because it spreads activation through the edge
 * graph and combines user/assistant/now signals, so the ≤10-char guard
 * v1 needs would unnecessarily starve v2 on short greetings.
 */
function readRawUserText(message: Message | undefined): string | null {
  if (!message) return null;
  const texts = message.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text.trim())
    .filter((t) => t.length > 0);
  if (texts.length === 0) return null;
  return texts.join(" ");
}

/**
 * Walk back through the conversation history and collect the most recent
 * `K` `(assistant, user)` turn pairs for the router prompt. Each pair
 * represents the assistant's reply followed by the user message that
 * came after — the last pair's `userMessage` is the just-arrived turn
 * that triggered this call.
 *
 * Behavior at K=1 is bit-identical to the pre-knob signature: one pair
 * with the prior assistant reply + the just-arrived user message.
 *
 * Edge cases:
 *   - If history has fewer than K full pairs available (e.g. early in a
 *     conversation), returns however many pairs were found, oldest first.
 *     The oldest pair may have `assistantMessage: ""` when there is a
 *     user message with no preceding assistant reply — `runRouterBatch`
 *     skips the `[assistant]:` line in that case.
 *   - Non-text content (tool_use, tool_result, images) is collapsed by
 *     joining all text blocks within a single message with spaces. This
 *     matches the v1-style extraction the router has used since K=1.
 */
function extractRecentTurnPairs(
  messages: Message[],
  k: number,
): RouterTurnPair[] {
  const messageText = (msg: Message): string =>
    msg.content
      .filter(
        (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
      )
      .map((b) => b.text)
      .join(" ");

  const pairs: RouterTurnPair[] = [];
  let pendingUser: string | null = null;
  for (let i = messages.length - 1; i >= 0 && pairs.length < k; i--) {
    const msg = messages[i];
    if (msg.role === "user" && pendingUser === null) {
      pendingUser = messageText(msg);
    } else if (msg.role === "assistant" && pendingUser !== null) {
      pairs.unshift({
        assistantMessage: messageText(msg),
        userMessage: pendingUser,
      });
      pendingUser = null;
    }
  }
  // Conversation start: a user message with no preceding assistant reply
  // still belongs in the prompt as the just-arrived turn. Emit it with an
  // empty `assistantMessage` so `runRouterBatch` renders only `[user]:`.
  if (pendingUser !== null && pairs.length < k) {
    pairs.unshift({ assistantMessage: "", userMessage: pendingUser });
  }
  // Defensive fallback: the router contract requires a non-empty array.
  // This only fires when `messages` has no user-text content at all
  // (currently impossible since the agent loop always appends a user
  // turn before invoking the v2 path, but cheap to keep correct).
  if (pairs.length === 0) {
    pairs.push({ assistantMessage: "", userMessage: "" });
  }
  return pairs;
}
