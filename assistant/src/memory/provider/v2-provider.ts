/**
 * `V2MemoryProvider` — {@link MemoryProvider} adapter over the v2
 * concept-page (activation) memory system.
 *
 * Delegates to the existing v2 surface rather than re-implementing it:
 *   - injection: `v2/injection.ts` `injectMemoryV2Block` (context-load and
 *     per-turn modes) → mapped to {@link InjectionBlock}s.
 *   - remember-write tools: the shared `remember`/`recall` tools, whose
 *     handlers append to the concept-page corpus that v2 reads from.
 *   - consolidation/write enqueue: `enqueueMemoryRetrospectiveIfEnabled`,
 *     the same post-turn trigger the live v2 path fires.
 *
 * No call site consumes this yet — it is additive scaffolding selected by
 * `memory.provider` in a later PR.
 */

import { getConfig } from "../../config/loader.js";
import type { InjectionBlock } from "../../plugins/types.js";
import { recallTool, rememberTool } from "../../tools/memory/register.js";
import type { ToolDefinition } from "../../tools/types.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { getDb } from "../../persistence/db-connection.js";
import { enqueueMemoryRetrospectiveIfEnabled } from "../memory-retrospective-enqueue.js";
import {
  injectMemoryV2Block,
  type InjectMemoryV2Mode,
} from "../v2/injection.js";
import { loadNowText } from "../v2/now-text.js";
import { extractRecentTurnPairs } from "../v2/router.js";
import type { MemoryProvider, MemoryProviderContext } from "./types.js";

/**
 * Stable id for the `<memory>` injection block this provider contributes.
 * Mirrors the placement the live v2 path uses (the block is prepended onto
 * the current user message's content).
 */
const V2_MEMORY_BLOCK_ID = "memory-v2";

/**
 * Run the v2 injector for the given mode and map its `<memory>` block onto an
 * {@link InjectionBlock} array. Returns an empty array when v2 is disabled or
 * the injector renders nothing new (the cache-stable empty path).
 */
async function inject(
  ctx: MemoryProviderContext,
  mode: InjectMemoryV2Mode,
): Promise<InjectionBlock[]> {
  if (!ctx.config.v2.enabled) {
    return [];
  }

  const config = getConfig();
  const workspaceDir = getWorkspaceDir();
  const nowText = await loadNowText(workspaceDir);
  const recentTurnPairs = extractRecentTurnPairs(
    ctx.messages,
    ctx.config.v2.router.historical_pairs,
  );

  const result = await injectMemoryV2Block({
    database: getDb(),
    conversationId: ctx.conversationId,
    currentTurn: 0,
    recentTurnPairs,
    nowText,
    messageId: ctx.requestId,
    mode,
    config,
  });

  if (!result.block) {
    return [];
  }

  return [
    {
      id: V2_MEMORY_BLOCK_ID,
      text: result.block,
      placement: "prepend-user-tail",
      meta: { mode, toInject: result.toInject },
    },
  ];
}

/**
 * The v2 (concept-page activation) memory system expressed as a
 * {@link MemoryProvider}.
 */
export const V2MemoryProvider = {
  id: "v2",

  retrieveForContext(ctx: MemoryProviderContext): Promise<InjectionBlock[]> {
    return inject(ctx, "context-load");
  },

  retrieveForTurn(ctx: MemoryProviderContext): Promise<InjectionBlock[]> {
    return inject(ctx, "per-turn");
  },

  async onTurnCommit(ctx: MemoryProviderContext): Promise<void> {
    enqueueMemoryRetrospectiveIfEnabled({
      conversationId: ctx.conversationId,
      trigger: "lifecycle",
    });
  },

  provideTools(): ToolDefinition[] {
    return [rememberTool, recallTool];
  },

  async init(): Promise<void> {},

  async shutdown(): Promise<void> {},
} satisfies MemoryProvider;
