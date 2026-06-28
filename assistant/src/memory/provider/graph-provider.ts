/**
 * `GraphMemoryProvider` — the v1 graph memory system expressed as a
 * {@link MemoryProvider}.
 *
 * Thin adapter over the existing graph modules: it delegates retrieval to
 * `graph/retriever.ts`, rendering to `graph/injection.ts`, and post-turn
 * consolidation enqueue to `memory/memory-retrospective-enqueue.ts`, then maps
 * the results into the {@link InjectionBlock} shape daemon core consumes. No
 * call site selects this provider yet — wiring lands in a later PR.
 */

import { getConfig } from "../../config/loader.js";
import type { InjectionBlock } from "../../plugins/types.js";
import type { ContentBlock, Message } from "../../providers/types.js";
import type { ToolDefinition } from "../../tools/types.js";
import {
  assembleContextBlock,
  assembleInjectionBlock,
  InContextTracker,
} from "../graph/injection.js";
import { loadContextMemory, retrieveForTurn } from "../graph/retriever.js";
import {
  graphRecallDefinition,
  graphRememberDefinition,
} from "../graph/tools.js";
import { wrapMemoryBlock } from "../memory-marker.js";
import { enqueueMemoryRetrospectiveIfEnabled } from "../memory-retrospective-enqueue.js";
import type { MemoryProvider, MemoryProviderContext } from "./types.js";

/** Memory isolation scope used by the live graph path. */
const GRAPH_SCOPE_ID = "default";

/** Stable injection-block ids matching the two graph injection modes. */
const CONTEXT_BLOCK_ID = "memory-graph-context-load";
const TURN_BLOCK_ID = "memory-graph-per-turn";

/** Read the text content of a single message, joined and trimmed. */
function messageText(message: Message): string {
  return message.content
    .filter(
      (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
    )
    .map((b) => b.text.trim())
    .filter((t) => t.length > 0)
    .join(" ");
}

/**
 * Pull the last user message's text and raw blocks plus the preceding
 * assistant message's text from a turn's working message array — the inputs the
 * graph retriever's per-turn path consumes.
 */
function lastExchange(messages: Message[]): {
  userLast: string;
  userLastBlocks: ContentBlock[];
  assistantLast: string;
} {
  let userLast = "";
  let userLastBlocks: ContentBlock[] = [];
  let assistantLast = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const text = messageText(msg);
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
  return { userLast, userLastBlocks, assistantLast };
}

/**
 * The v1 graph system as a {@link MemoryProvider}. Retrieval and rendering
 * delegate to the existing graph modules; the adapter only maps their output
 * into {@link InjectionBlock}s and forwards the retrospective enqueue.
 */
export const GraphMemoryProvider = {
  id: "graph",

  async retrieveForContext(
    ctx: MemoryProviderContext,
  ): Promise<InjectionBlock[]> {
    const config = getConfig();
    const userQuery = ctx.messages.length
      ? messageText(ctx.messages[ctx.messages.length - 1])
      : "";
    const recentSummaries = ctx.messages
      .filter((m) => m.role === "user")
      .map(messageText)
      .filter((t) => t.length > 0);

    const result = await loadContextMemory({
      scopeId: GRAPH_SCOPE_ID,
      recentSummaries,
      config,
      userQuery: userQuery.length > 0 ? userQuery : undefined,
    });

    const block = assembleContextBlock(result.nodes, {
      serendipityNodes: result.serendipityNodes,
    });
    if (!block) return [];

    return [
      {
        id: CONTEXT_BLOCK_ID,
        text: wrapMemoryBlock(block),
        placement: "prepend-user-tail",
      },
    ];
  },

  async retrieveForTurn(ctx: MemoryProviderContext): Promise<InjectionBlock[]> {
    const config = getConfig();
    const { userLast, userLastBlocks, assistantLast } = lastExchange(
      ctx.messages,
    );

    const result = await retrieveForTurn({
      assistantLastMessage: assistantLast,
      userLastMessage: userLast,
      userLastMessageBlocks: userLastBlocks,
      scopeId: GRAPH_SCOPE_ID,
      config,
      tracker: new InContextTracker(),
    });

    const block = assembleInjectionBlock(result.nodes);
    if (!block) return [];

    return [
      {
        id: TURN_BLOCK_ID,
        text: wrapMemoryBlock(block),
        placement: "after-memory-prefix",
      },
    ];
  },

  async onTurnCommit(ctx: MemoryProviderContext): Promise<void> {
    enqueueMemoryRetrospectiveIfEnabled({
      conversationId: ctx.conversationId,
      trigger: "lifecycle",
    });
  },

  provideTools(): ToolDefinition[] {
    return [graphRememberDefinition, graphRecallDefinition];
  },

  async init(): Promise<void> {},

  async shutdown(): Promise<void> {},
} satisfies MemoryProvider;
