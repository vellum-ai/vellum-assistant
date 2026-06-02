/**
 * Default `compaction` behavior: summarizes conversation history when the
 * context window fills up.
 *
 * This module is side-effect free: importing it does not register any plugin.
 *
 * Delegates to the orchestrator's existing {@link ContextWindowManager}
 * instance, read from `ctx.contextWindowManager` on the {@link TurnContext} as
 * a typed optional field. The orchestrator is responsible for attaching that
 * handle to the per-turn context. If the handle is missing, this throws a
 * {@link PluginExecutionError} so the bug surfaces with clear attribution
 * instead of a late `undefined.maybeCompact is not a function`.
 */

import type {
  ContextWindowCompactOptions,
  ContextWindowManager,
  ContextWindowResult,
} from "../../../context/window-manager.js";
import type { Message } from "../../../providers/types.js";
import {
  type CompactionArgs,
  type CompactionResult,
  PluginExecutionError,
  type TurnContext,
} from "../../types.js";

/**
 * Name under which the default plugin registers. Exposed so tests and later
 * plugins can assert registration order or override the default via
 * composition.
 */
export const DEFAULT_COMPACTION_PLUGIN_NAME = "default-compaction";

/**
 * Read `contextWindowManager` off the turn context. Throws
 * {@link PluginExecutionError} when absent so the failure attributes cleanly
 * to the default plugin instead of manifesting as a later NPE.
 */
function extractManager(ctx: TurnContext): ContextWindowManager {
  const manager = ctx.contextWindowManager;
  if (
    manager == null ||
    typeof manager !== "object" ||
    typeof (manager as { maybeCompact?: unknown }).maybeCompact !== "function"
  ) {
    throw new PluginExecutionError(
      "default-compaction: ctx.contextWindowManager is missing — orchestrator must attach it before invoking compaction",
      DEFAULT_COMPACTION_PLUGIN_NAME,
    );
  }
  return manager;
}

/**
 * Run compaction for the turn: reads the context window manager off the turn
 * context and returns the (possibly summarized) message history from
 * `maybeCompact`.
 */
export async function defaultCompactionTerminal(
  args: CompactionArgs,
  ctx: TurnContext,
): Promise<CompactionResult> {
  const manager = extractManager(ctx);
  const messages = args.messages as Message[];
  const options = args.options as ContextWindowCompactOptions | undefined;
  const result: ContextWindowResult = await manager.maybeCompact(
    messages,
    args.signal,
    options,
  );
  return result;
}
