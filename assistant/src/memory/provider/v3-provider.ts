/**
 * {@link MemoryProvider} adapter over the memory-v3 shadow engine.
 *
 * Thin delegation layer: every retrieval call routes through the EXISTING v3
 * injectors (`memoryV3Injector`, `memoryV3SpotlightInjector` in
 * `plugins/defaults/memory-v3-shadow/injector.ts`), which share one
 * orchestration result per turn via the `observeTurnOnce` memo. The adapter
 * reuses that path verbatim — it never re-runs `orchestrate`/`selectPool`
 * itself, so the memo, the everInjected store, the prune valve, and the
 * `memory_v3_selections` write remain the single source of truth.
 *
 * v3 has no context-load prefix distinct from its per-turn injection: both the
 * frozen net-new card block and the ephemeral spotlight block are produced on
 * the per-turn path. So {@link V3MemoryProvider.retrieveForContext} contributes
 * nothing and {@link V3MemoryProvider.retrieveForTurn} returns the card +
 * spotlight blocks in injector order.
 *
 * The cross-directory import (`memory/provider/` → `plugins/defaults/
 * memory-v3-shadow/`) is the established direction — `memory/
 * register-job-handlers.ts` and `memory/graph/conversation-graph-memory.ts`
 * already import from the same shadow tree, and no boundary guard forbids it.
 */

import {
  memoryV3Injector,
  memoryV3SpotlightInjector,
} from "../../plugins/defaults/memory-v3-shadow/injector.js";
import type { InjectionBlock, TurnContext } from "../../plugins/types.js";
import { ROUTES as MEMORY_V3_ROUTES } from "../../runtime/routes/memory-v3-routes.js";
import type { RouteDefinition } from "../../runtime/routes/types.js";
import type { ToolDefinition } from "../../tools/types.js";
import type { MemoryProvider, MemoryProviderContext } from "./types.js";

/**
 * Build the {@link TurnContext} the v3 injectors consume from the provider
 * context. Only the fields the injectors read (`requestId`, `conversationId`,
 * `turnIndex`, `trust`) are populated; every other `TurnContext` field is an
 * optional per-turn injection input the v3 injectors ignore.
 */
function toTurnContext(ctx: MemoryProviderContext): TurnContext {
  return {
    requestId: ctx.requestId,
    conversationId: ctx.conversationId,
    turnIndex: ctx.turnIndex,
    trust: ctx.trust,
  };
}

/**
 * v3 implementation of {@link MemoryProvider}. Delegates all retrieval to the
 * shadow injectors; contributes no model-visible tools (v3 is a
 * retrieval/injection system with no `remember`-style tool surface) and the v3
 * maintenance routes. `onTurnCommit`, `init`, and `shutdown` are no-ops: v3's
 * everInjected write and prune-valve schedule are driven by the injector's
 * commit callback at runtime assembly, and its consolidation enqueue rides the
 * v2 consolidation job — neither is a per-turn provider hook.
 */
export const V3MemoryProvider = {
  id: "v3",

  async retrieveForContext(
    _ctx: MemoryProviderContext,
  ): Promise<InjectionBlock[]> {
    // v3 produces no context-load prefix distinct from its per-turn injection.
    return [];
  },

  async retrieveForTurn(ctx: MemoryProviderContext): Promise<InjectionBlock[]> {
    const turnCtx = toTurnContext(ctx);
    // Cards first, then spotlight — the injectors' own order (1000 then 1001),
    // preserved so the spotlight block splices immediately after the cards
    // block. Each injector shares the per-turn orchestration memo internally.
    const cards = await memoryV3Injector.produce(turnCtx);
    const spotlight = await memoryV3SpotlightInjector.produce(turnCtx);
    return [cards, spotlight].filter(
      (block): block is InjectionBlock => block != null,
    );
  },

  async onTurnCommit(_ctx: MemoryProviderContext): Promise<void> {
    // No-op: v3 writes (everInjected + prune valve) are deferred to the
    // injector's commit callback fired by runtime assembly, and its
    // consolidation enqueue rides the v2 consolidation job.
  },

  provideTools(): ToolDefinition[] {
    return [];
  },

  provideRoutes(): RouteDefinition[] {
    return MEMORY_V3_ROUTES;
  },

  async init(): Promise<void> {
    // No-op: the v3 lanes lazy-init on first orchestration.
  },

  async shutdown(): Promise<void> {
    // No-op.
  },
} satisfies MemoryProvider;
