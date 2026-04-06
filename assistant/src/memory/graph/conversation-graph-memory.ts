// ---------------------------------------------------------------------------
// Memory Graph — Conversation-level memory integration
//
// Replaces the old `prepareMemoryContext` from conversation-memory.ts.
// Manages the InContextTracker lifecycle and dispatches to the correct
// retrieval mode based on conversation state.
// ---------------------------------------------------------------------------

import { and, desc, eq, inArray, ne, notInArray } from "drizzle-orm";

import type { AssistantConfig } from "../../config/types.js";
import { estimateTextTokens } from "../../context/token-estimator.js";
import type { ServerMessage } from "../../daemon/message-protocol.js";
import type {
  ContentBlock,
  ImageContent,
  Message,
} from "../../providers/types.js";
import { getLogger } from "../../util/logger.js";
import { getDb } from "../db.js";
import { memorySummaries } from "../schema.js";
import { conversations } from "../schema/conversations.js";
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
  private scopeId: string;
  private conversationId: string;
  private lastInjectedBlock: string | null = null;
  private lastInjectedNodeIds: string[] = [];
  private lastInjectedImages: Map<string, ResolvedImage> = new Map();

  constructor(scopeId: string, conversationId: string) {
    this.scopeId = scopeId;
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
        eq(memorySummaries.scopeId, this.scopeId),
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
    // Strip any existing <memory __injected> blocks from the last user message
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

        // Extract the first user message as an additional retrieval signal
        // so context-load biases toward what the user is asking about
        const firstUserText = extractUserText(lastMessage);
        if (firstUserText) {
          recentSummaries.unshift(firstUserText);
        }

        return await this.runContextLoad(
          messages,
          config,
          recentSummaries,
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
    signal: AbortSignal,
    onEvent: (msg: ServerMessage) => void,
  ) {
    const result = await loadContextMemory({
      scopeId: this.scopeId,
      recentSummaries,
      config,
      signal,
    });

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
      scopeId: this.scopeId,
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
    };
  }
}

// ---------------------------------------------------------------------------
// Injection helper — same pattern as old injectMemoryRecallAsUserBlock
// ---------------------------------------------------------------------------

/**
 * Remove all memory-injected blocks from the last user message.
 *
 * `injectMemoryBlock` always prepends blocks in this order:
 *   1. `<memory __injected>…</memory>` text block
 *   2. For each image: `<memory_image>…</memory_image>` text + `image` block
 *
 * We strip all leading blocks that match this pattern so that
 * `reinjectCachedMemory` is idempotent — no duplicate images after compaction.
 */
export function stripExistingMemoryInjections(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return messages;

  // Walk from the front and skip all memory-injected blocks.
  // The injection prefix is always contiguous at the start of content.
  // Memory-injected images use a 3-block pattern: opening <memory_image> text,
  // image block, closing </memory_image> text (see injectMemoryBlock).
  // Legacy 2-block pattern (no closing tag) is also handled for backward compat.
  // Only strip image blocks that follow a marker — user-attached images must be preserved.
  let firstNonMemory = 0;
  let prevWasMemoryImageMarker = false;
  const content = last.content;
  while (firstNonMemory < content.length) {
    const block = content[firstNonMemory];
    if (
      block.type === "text" &&
      block.text.startsWith("<memory __injected>\n")
    ) {
      firstNonMemory++;
      prevWasMemoryImageMarker = false;
    } else if (
      block.type === "text" &&
      block.text.startsWith("<memory_image")
    ) {
      firstNonMemory++;
      prevWasMemoryImageMarker = true;
    } else if (block.type === "image" && prevWasMemoryImageMarker) {
      firstNonMemory++;
      prevWasMemoryImageMarker = false;
    } else if (
      block.type === "text" &&
      block.text === "</memory_image>"
    ) {
      // Closing tag from the 3-block pattern
      firstNonMemory++;
    } else {
      break;
    }
  }

  // Nothing to strip
  if (firstNonMemory === 0) return messages;

  return [
    ...messages.slice(0, -1),
    { ...last, content: content.slice(firstNonMemory) },
  ];
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
          text: `<memory __injected>\n${text}\n</memory>`,
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
    text: `<memory __injected>\n${text}\n</memory>`,
  });

  return [
    ...cleaned.slice(0, -1),
    { ...userTail, content: [...blocks, ...userTail.content] },
  ];
}

/** Extract text content from a user message. */
function extractUserText(message: Message): string | null {
  const texts = message.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text.trim())
    .filter((t) => t.length > 0);
  if (texts.length === 0) return null;
  const joined = texts.join(" ");
  // Skip very short messages ("hi", "yes") — they produce vague embeddings
  return joined.length > 10 ? joined : null;
}
