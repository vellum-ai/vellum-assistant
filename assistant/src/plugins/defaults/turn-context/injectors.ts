/**
 * `turn-context` plugin injectors.
 *
 * Contributes the unified `<turn_context>` block that combines temporal, actor,
 * channel, and interface grounding into a single per-turn injection. Active in
 * both `full` and `minimal` mode — turn context is safety-critical grounding
 * that must survive injection downgrade.
 */

import type { InjectionBlock, Injector, TurnContext } from "../../types.js";
import { DEFAULT_INJECTOR_ORDER } from "../injector-order.js";
import { buildUnifiedTurnContextBlock } from "./unified-turn-context.js";

/**
 * `unified-turn-context` injector — order 20, prepend-user-tail.
 *
 * Injects the `<turn_context>` block that combines temporal, actor, channel,
 * and interface context. The orchestrator resolves the block's inputs onto the
 * per-turn {@link TurnContext}; this injector builds the text from them
 * via `buildUnifiedTurnContextBlock`. Emits nothing when no `timestamp` is
 * present (the inputs were not resolved for this turn).
 *
 * Active in both `full` and `minimal` mode — unified turn context is
 * safety-critical grounding that must survive injection downgrade.
 */
const unifiedTurnContextInjector: Injector = {
  name: "unified-turn-context",
  order: DEFAULT_INJECTOR_ORDER.unifiedTurnContext,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    const { timestamp } = ctx;
    if (!timestamp) return null;
    const text = buildUnifiedTurnContextBlock({
      timestamp,
      interfaceName: ctx.interfaceName,
      clientOs: ctx.clientOs,
      channelName: ctx.channelName,
      actorContext: ctx.actorContext,
      configuredUserTimezone: ctx.configuredUserTimezone,
      clientTimezone: ctx.clientTimezone,
      detectedTimezone: ctx.detectedTimezone,
      timeSinceLastMessage: ctx.timeSinceLastMessage,
      modelProfile: ctx.modelProfile,
    });
    return {
      id: "unified-turn-context",
      text,
      placement: "prepend-user-tail",
    };
  },
};

/** The `turn-context` plugin's runtime injectors. */
export const turnContextInjectors: Injector[] = [unifiedTurnContextInjector];
