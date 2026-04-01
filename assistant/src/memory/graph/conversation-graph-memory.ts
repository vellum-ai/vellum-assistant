// ---------------------------------------------------------------------------
// Memory Graph — Conversation-level memory integration
//
// Replaces the old `prepareMemoryContext` from conversation-memory.ts.
// Manages the InContextTracker lifecycle and dispatches to the correct
// retrieval mode based on conversation state.
// ---------------------------------------------------------------------------

import { and, desc, eq, ne } from "drizzle-orm";

import type { AssistantConfig } from "../../config/types.js";
import { estimateTextTokens } from "../../context/token-estimator.js";
import type { ServerMessage } from "../../daemon/message-protocol.js";
import type { Message } from "../../providers/types.js";
import { getLogger } from "../../util/logger.js";
import { getDb } from "../db.js";
import { memorySummaries } from "../schema.js";
import { conversations } from "../schema/conversations.js";
import {
  assembleContextBlock,
  assembleInjectionBlock,
  InContextTracker,
} from "./injection.js";
import {
  loadContextMemory,
  REFRESH_INTERVAL_TURNS,
  refreshContextMemory,
  retrieveForTurn,
} from "./retriever.js";

const log = getLogger("graph-conversation-memory");

// ---------------------------------------------------------------------------
// Per-conversation state
// ---------------------------------------------------------------------------

/**
 * Manages memory graph state for a single conversation.
 * Create one per Conversation instance. Persists across turns.
 */
export class ConversationGraphMemory {
  readonly tracker = new InContextTracker();
  private turnCount = 0;
  private initialized = false;
  private lastCompactedAt: number | null = null;
  private needsReload = false;
  private scopeId: string;
  private conversationId: string;

  constructor(scopeId: string, conversationId: string) {
    this.scopeId = scopeId;
    this.conversationId = conversationId;
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
        .where(and(baseWhere, ne(conversations.conversationType, "background")))
        .orderBy(desc(memorySummaries.updatedAt))
        .limit(3)
        .all();

      if (userRows.length >= 3) {
        return userRows.map((r) => r.summary);
      }

      // Fill remaining slots with at most 1 background conversation
      const remaining = Math.min(1, 3 - userRows.length);
      const bgRows = db
        .select({ summary: memorySummaries.summary })
        .from(memorySummaries)
        .innerJoin(
          conversations,
          eq(memorySummaries.scopeKey, conversations.id),
        )
        .where(
          and(baseWhere, eq(conversations.conversationType, "background")),
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
    this.lastCompactedAt = Date.now();
    log.info(
      { compactedMessageCount },
      "Compaction detected — will reload context on next turn",
    );
  }

  /**
   * Main entry point — called on every turn before the LLM sees the messages.
   *
   * Dispatches to the appropriate retrieval mode:
   * - Turn 1 (or after compaction): full context load
   * - Every 5 turns: periodic refresh
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
    mode: "context-load" | "refresh" | "per-turn" | "none";
  }> {
    this.turnCount++;
    this.tracker.advanceTurn();

    const noopResult = {
      runMessages: messages,
      injectedTokens: 0,
      latencyMs: 0,
      mode: "none" as const,
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

      if (this.turnCount % REFRESH_INTERVAL_TURNS === 0) {
        return await this.runRefresh(messages, config, abortSignal);
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
      return {
        runMessages: messages,
        injectedTokens: 0,
        latencyMs: result.latencyMs,
        mode: "context-load" as const,
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
      };
    }

    const injectedTokens = estimateTextTokens(contextBlock);

    onEvent({
      type: "memory_status",
      enabled: true,
      degraded: false,
    } as ServerMessage);

    return {
      runMessages: injectTextBlock(messages, contextBlock),
      injectedTokens,
      latencyMs: result.latencyMs,
      mode: "context-load" as const,
    };
  }

  private async runRefresh(
    messages: Message[],
    config: AssistantConfig,
    signal: AbortSignal,
  ) {
    // Build recent turns text from the last ~6 messages
    const recentTurns = messages
      .slice(-6)
      .map((m) => {
        const textBlocks = m.content.filter(
          (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
        );
        if (textBlocks.length === 0) return "";
        return `[${m.role}]: ${textBlocks.map((b) => b.text).join(" ")}`;
      })
      .filter((t) => t.length > 0)
      .join("\n\n");

    const result = await refreshContextMemory({
      recentTurnsText: recentTurns,
      scopeId: this.scopeId,
      config,
      tracker: this.tracker,
      signal,
    });

    if (result.nodes.length === 0) {
      return {
        runMessages: messages,
        injectedTokens: 0,
        latencyMs: result.latencyMs,
        mode: "refresh" as const,
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
        mode: "refresh" as const,
      };
    }

    return {
      runMessages: injectTextBlock(messages, injectionBlock),
      injectedTokens: estimateTextTokens(injectionBlock),
      latencyMs: result.latencyMs,
      mode: "refresh" as const,
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

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const text = msg.content
        .filter(
          (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
        )
        .map((b) => b.text)
        .join(" ");

      if (msg.role === "user" && !userLast) {
        userLast = text;
      } else if (msg.role === "assistant" && !assistantLast) {
        assistantLast = text;
      }
      if (userLast && assistantLast) break;
    }

    const result = await retrieveForTurn({
      assistantLastMessage: assistantLast,
      userLastMessage: userLast,
      scopeId: this.scopeId,
      config,
      tracker: this.tracker,
      signal,
    });

    if (result.nodes.length === 0) {
      return {
        runMessages: messages,
        injectedTokens: 0,
        latencyMs: result.latencyMs,
        mode: "per-turn" as const,
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
      };
    }

    return {
      runMessages: injectTextBlock(messages, injectionBlock),
      injectedTokens: estimateTextTokens(injectionBlock),
      latencyMs: result.latencyMs,
      mode: "per-turn" as const,
    };
  }
}

// ---------------------------------------------------------------------------
// Injection helper — same pattern as old injectMemoryRecallAsUserBlock
// ---------------------------------------------------------------------------

function injectTextBlock(messages: Message[], text: string): Message[] {
  if (text.trim().length === 0) return messages;
  if (messages.length === 0) return messages;
  const userTail = messages[messages.length - 1];
  if (!userTail || userTail.role !== "user") return messages;
  return [
    ...messages.slice(0, -1),
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
