// ---------------------------------------------------------------------------
// Memory Graph — Conversation-level memory integration
//
// Replaces the old `prepareMemoryContext` from conversation-memory.ts.
// Manages the InContextTracker lifecycle and dispatches to the correct
// retrieval mode based on conversation state.
// ---------------------------------------------------------------------------

import { and, desc, eq, inArray, ne, notInArray } from "drizzle-orm";

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../../config/types.js";
import { estimateTextTokens } from "../../context/token-estimator.js";
import type { ServerMessage } from "../../daemon/message-protocol.js";
import type {
  ContentBlock,
  ImageContent,
  Message,
} from "../../providers/types.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { getDb } from "../db-connection.js";
import type { QdrantSparseVector } from "../qdrant-client.js";
import { memorySummaries } from "../schema.js";
import { conversations } from "../schema/conversations.js";
import {
  injectMemoryV2Block,
  type InjectMemoryV2Mode,
} from "../v2/injection.js";
import { loadNowText } from "../v2/now-text.js";
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

  constructor(conversationId: string) {
    this.conversationId = conversationId;
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
  onCompacted(compactedMessageCount: number): void {
    // Evict everything — compaction summarized all prior turns.
    // The tracker can't know exactly which turns were compacted,
    // so we conservatively clear everything and reload.
    this.tracker.evictCompactedTurns(this.tracker.getTurn());
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
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
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
    const result = await loadContextMemory({
      scopeId: "default",
      recentSummaries,
      userQuery,
      config,
      signal,
    });

    this.initialized = true;
    this.needsReload = false;

    // v2 routing: when the feature flag and workspace config are both on,
    // replace v1's injection with the activation-pipeline output. v1
    // retrieval still runs above so its tracker stays warm — keeps the
    // off→on→off flag flip cheap and avoids invalidating cached metrics.
    // assistantMessage is empty: context-load fires on turn 1 / post-
    // compaction, so there is no immediately-prior assistant turn to
    // weight the activation against.
    //
    // Use the raw user text (no >10-char filter) so even short greetings
    // ("hi") get a fresh top-K activation dump on the first user message.
    // The activation pipeline is robust to weak ANN signal — it still falls
    // back to spreading + nowText to surface candidates.
    const rawUserText = readRawUserText(messages[messages.length - 1]);
    const v2 = await this.maybeRouteV2Injection(
      messages,
      config,
      "context-load",
      rawUserText ?? userQuery ?? "",
      "",
      signal,
    );
    if (v2.routed) {
      this.lastInjectedBlock = v2.injectedBlockText;
      this.lastInjectedNodeIds = [];
      this.lastInjectedImages = new Map();
      return {
        runMessages: v2.runMessages,
        injectedTokens: v2.injectedBlockText
          ? estimateTextTokens(v2.injectedBlockText)
          : 0,
        latencyMs: result.latencyMs,
        mode: "context-load" as const,
        injectedBlockText: v2.injectedBlockText,
        metrics: result.metrics,
        queryVector: result.queryVector,
        sparseVector: result.sparseVector,
        userQueryVector: result.userQueryVector,
        userQuerySparseVector: result.userQuerySparseVector,
      };
    }

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

    const result = await retrieveForTurn({
      assistantLastMessage: assistantLast,
      userLastMessage: userLast,
      userLastMessageBlocks: userLastBlocks,
      scopeId: "default",
      config,
      tracker: this.tracker,
      signal,
    });

    // v2 routing: same gating as `runContextLoad` — when the flag and config
    // are both on, the v2 activation pipeline produces the injection block
    // (or `null` for the cache-stable empty path). v1 retrieval above runs
    // unconditionally so the tracker stays in sync with the v1 nodes —
    // cheap insurance for an off→on→off flag flip mid-conversation.
    const v2 = await this.maybeRouteV2Injection(
      messages,
      config,
      "per-turn",
      userLast,
      assistantLast,
      signal,
    );
    if (v2.routed) {
      this.lastInjectedBlock = v2.injectedBlockText;
      this.lastInjectedNodeIds = [];
      this.lastInjectedImages = new Map();
      return {
        runMessages: v2.runMessages,
        injectedTokens: v2.injectedBlockText
          ? estimateTextTokens(v2.injectedBlockText)
          : 0,
        latencyMs: result.latencyMs,
        mode: "per-turn" as const,
        injectedBlockText: v2.injectedBlockText,
        metrics: result.metrics,
        queryVector: result.queryVector,
        sparseVector: result.sparseVector,
      };
    }

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
   * Route the v1 retrieval's injection step through the v2 activation
   * pipeline when the `memory-v2-enabled` feature flag *and* the workspace
   * config (`memory.v2.enabled`) are both on.
   *
   * The two outcomes the caller distinguishes via `routed`:
   *   - `routed: false` — v2 disabled; caller runs the existing v1 injection.
   *   - `routed: true`  — v2 ran. `runMessages` is either the v2-prepended
   *                        message list (block was non-null) or the input
   *                        messages unchanged (cache-stable empty path).
   *                        Caller does NOT fall through to v1 in either case.
   */
  private async maybeRouteV2Injection(
    messages: Message[],
    config: AssistantConfig,
    mode: InjectMemoryV2Mode,
    userMessage: string,
    assistantMessage: string,
    signal: AbortSignal,
  ): Promise<{
    routed: boolean;
    runMessages: Message[];
    injectedBlockText: string | null;
  }> {
    if (
      !isAssistantFeatureFlagEnabled("memory-v2-enabled", config) ||
      !config.memory.v2.enabled
    ) {
      return { routed: false, runMessages: messages, injectedBlockText: null };
    }

    const nowText = await loadNowText(getWorkspaceDir());
    const currentTurn = this.tracker.getTurn();

    const result = await injectMemoryV2Block({
      database: getDb(),
      conversationId: this.conversationId,
      currentTurn,
      userMessage,
      assistantMessage,
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
 * `injectMemoryBlock`. Memory-injected images use a 3-block pattern
 * (opening `<memory_image>` text + image + closing `</memory_image>` text),
 * followed by a `<memory>…</memory>` text block (legacy `<memory __injected>` is also accepted). A legacy
 * 2-block image pattern (no closing tag) is also accepted for backward
 * compatibility. The injection prefix is always contiguous at the start,
 * so we stop at the first non-memory block.
 */
export function countMemoryPrefixBlocks(content: ContentBlock[]): number {
  let firstNonMemory = 0;
  let prevWasMemoryImageMarker = false;
  let prevWasInjectedImage = false;
  while (firstNonMemory < content.length) {
    const block = content[firstNonMemory];
    if (
      block.type === "text" &&
      (block.text.startsWith("<memory>\n") ||
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

  const firstNonMemory = countMemoryPrefixBlocks(last.content);
  if (firstNonMemory === 0) return messages;

  return [
    ...messages.slice(0, -1),
    { ...last, content: last.content.slice(firstNonMemory) },
  ];
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
          text: `<memory>\n${text}\n</memory>`,
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
    text: `<memory>\n${text}\n</memory>`,
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
