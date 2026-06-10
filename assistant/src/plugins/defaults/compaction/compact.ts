/**
 * Default compaction implementation.
 *
 * Summarizes conversation history when the context window fills up by
 * delegating to the conversation's {@link ContextWindowManager}. The agent loop
 * calls {@link defaultCompact} directly with a {@link CompactionContext}; the
 * request carries the conversational inputs while the compaction module resolves
 * (and, if needed, builds) the manager from its per-conversation store.
 *
 * This module is side-effect free: importing it does not register any plugin.
 */

import type { Message } from "../../../providers/types.js";
import type { TrustClass } from "../../../runtime/actor-trust-resolver.js";
import { PluginExecutionError } from "../../types.js";
import { getContextWindowManager } from "./manager-store.js";
import type {
  ContextWindowResult,
  EmergencyCompactOptions,
} from "./window-manager.js";

/**
 * Name under which the default compaction plugin registers. Exposed so call
 * sites can attribute compaction failures to the default plugin.
 */
export const DEFAULT_COMPACTION_PLUGIN_NAME = "default-compaction";

/**
 * Self-describing compaction request handed to {@link defaultCompact}. Carries
 * the conversational inputs plus the `conversationId` the compaction module
 * resolves its manager from, so callers never hold or pass a manager handle and
 * the request can grow toward a model-facing compaction-method shape without
 * coupling callers to the manager's option bag.
 */
export interface CompactionContext {
  /** Conversation whose manager performs the compaction. */
  conversationId: string;
  /** Message history to consider for compaction. */
  messages: Message[];
  /** Abort signal forwarded to the compaction summary call. */
  signal?: AbortSignal;
  /** Skip the auto-threshold check (forced/overflow/emergency compaction). */
  force?: boolean;
  /** Per-conversation inference-profile override for the summary call. */
  overrideProfile?: string | null;
  /** Pre-computed token estimate from a prior `shouldCompact()` call. */
  precomputedEstimate?: number;
  /** Legacy keep-boundary hint forwarded to the compactor. */
  minKeepRecentUserTurns?: number;
  /** Trust class of the actor whose turn triggered compaction. */
  actorTrustClass?: TrustClass;
  /**
   * Set when this compaction is recovering from a provider context-overflow
   * rejection rather than the ordinary auto-threshold trip. Its presence
   * routes the request through the manager's reduction ladder (which escalates
   * one rung per call) instead of plain forced compaction; the agent loop
   * records it in its overflow catch and forwards it on the next gate pass.
   */
  overflowSignal?: {
    /** Provider-reported token count from the rejection, or `null`. */
    actualTokens: number | null;
    /** Whether a human is present this turn (drives the auto-compress policy). */
    isInteractive: boolean;
  };
}

/**
 * Run compaction for the turn: resolves the conversation's context window
 * manager from the compaction store (building it on first access) and returns
 * the (possibly summarized) message history.
 */
export async function defaultCompact(
  context: CompactionContext,
): Promise<ContextWindowResult> {
  const { conversationId, messages, signal, overflowSignal, ...options } =
    context;
  const manager = getContextWindowManager(conversationId);
  if (manager == null) {
    throw new PluginExecutionError(
      `default-compaction: no ContextWindowManager registered for conversation ${conversationId} — the conversation must register one before compaction runs`,
      DEFAULT_COMPACTION_PLUGIN_NAME,
    );
  }
  if (overflowSignal) {
    return manager.recoverContextOverflow(
      messages,
      {
        actualTokens: overflowSignal.actualTokens,
        isInteractive: overflowSignal.isInteractive,
        overrideProfile: options.overrideProfile,
        actorTrustClass: options.actorTrustClass,
      },
      signal,
    );
  }
  return manager.maybeCompact(messages, signal, options);
}

/**
 * Self-describing emergency-compaction request handed to
 * {@link defaultEmergencyCompact}. Mirrors {@link CompactionContext} but
 * carries the provider-reported token estimate at the overflow that triggered
 * recovery, which sizes the summarize-around-last-tool-pair cut.
 */
export interface EmergencyCompactionContext extends EmergencyCompactOptions {
  /** Conversation whose manager performs the emergency compaction. */
  conversationId: string;
  /** Message history to summarize around the last tool_use/tool_result pair. */
  messages: Message[];
  /** Abort signal forwarded to the compaction summary call. */
  signal?: AbortSignal;
}

/**
 * Run emergency mid-turn compaction for the turn: resolves the conversation's
 * context window manager from the compaction store and summarizes everything
 * before the last tool_use/tool_result pair, preserving the agent's most recent
 * action context while aggressively compressing earlier history.
 */
export async function defaultEmergencyCompact(
  context: EmergencyCompactionContext,
): Promise<ContextWindowResult> {
  const { conversationId, messages, signal, ...options } = context;
  const manager = getContextWindowManager(conversationId);
  if (manager == null) {
    throw new PluginExecutionError(
      `default-compaction: no ContextWindowManager registered for conversation ${conversationId} — the conversation must register one before emergency compaction runs`,
      DEFAULT_COMPACTION_PLUGIN_NAME,
    );
  }
  return manager.emergencyCompact(messages, options, signal);
}
