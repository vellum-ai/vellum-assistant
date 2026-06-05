/**
 * Default compaction implementation.
 *
 * Summarizes conversation history when the context window fills up by
 * delegating to a {@link ContextWindowManager}. The agent loop calls
 * {@link defaultCompact} directly with a {@link CompactionContext}; the request
 * carries the conversational inputs while the manager performs the work.
 *
 * This module is side-effect free: importing it does not register any plugin.
 */

import type {
  ContextWindowManager,
  ContextWindowResult,
} from "../../../context/window-manager.js";
import type { Message } from "../../../providers/types.js";
import type { TrustClass } from "../../../runtime/actor-trust-resolver.js";

/**
 * Name under which the default compaction plugin registers. Exposed so call
 * sites can attribute compaction failures to the default plugin.
 */
export const DEFAULT_COMPACTION_PLUGIN_NAME = "default-compaction";

/**
 * Self-describing compaction request handed to {@link defaultCompact}. Carries
 * the conversational inputs plus the {@link ContextWindowManager} that runs the
 * summary, so the request is the part that can grow toward a model-facing
 * compaction-method shape without coupling callers to the manager's option bag.
 */
export interface CompactionContext {
  /** Context window manager that performs the compaction. */
  manager: ContextWindowManager;
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
}

/**
 * Run compaction for the turn: delegates to the request's context window
 * manager and returns the (possibly summarized) message history.
 */
export async function defaultCompact(
  context: CompactionContext,
): Promise<ContextWindowResult> {
  const { manager, messages, signal, ...options } = context;
  return manager.maybeCompact(messages, signal, options);
}
