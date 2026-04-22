/**
 * Default `compaction` plugin.
 *
 * Delegates to the orchestrator's existing
 * {@link import("../../context/window-manager.js").ContextWindowManager}
 * instance. No behavior change relative to the pre-plugin call site — the
 * plugin only exists so custom plugins registered in later PRs can observe
 * arguments, short-circuit to a different summary, or post-process the
 * {@link import("../../context/window-manager.js").ContextWindowResult}
 * before the orchestrator consumes it.
 *
 * Lookup: the default middleware reads `ctx.contextWindowManager` from the
 * {@link TurnContext} via a lenient cast. The orchestrator is responsible
 * for attaching that handle to the per-turn context it hands to
 * {@link runPipeline}. `TurnContext` intentionally stays slim at the type
 * level — we avoid widening it to carry orchestrator-only accessors — and
 * use the same lenient-read pattern the pipeline runner already uses for
 * its optional `logger` slot. If the handle is missing, the middleware
 * throws a {@link PluginExecutionError} so the bug surfaces with clear
 * attribution instead of a late `undefined.maybeCompact is not a function`.
 *
 * Design doc: `.private/plans/agent-plugin-system.md` (PR 25).
 */

import type {
  ContextWindowCompactOptions,
  ContextWindowManager,
  ContextWindowResult,
} from "../../context/window-manager.js";
import type { Message } from "../../providers/types.js";
import {
  type CompactionArgs,
  type CompactionResult,
  type Middleware,
  type Plugin,
  PluginExecutionError,
  type TurnContext,
} from "../types.js";

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
  const maybe = (ctx as { contextWindowManager?: unknown })
    .contextWindowManager;
  if (
    maybe == null ||
    typeof maybe !== "object" ||
    typeof (maybe as { maybeCompact?: unknown }).maybeCompact !== "function"
  ) {
    throw new PluginExecutionError(
      "default-compaction: ctx.contextWindowManager is missing — orchestrator must attach it before invoking the compaction pipeline",
      DEFAULT_COMPACTION_PLUGIN_NAME,
    );
  }
  return maybe as ContextWindowManager;
}

/**
 * Default terminal behavior. Exposed as a standalone function (rather than
 * inlined in the plugin object) so the orchestrator can pass it directly to
 * {@link runPipeline} as the terminal handler. Keeping terminal-vs-middleware
 * separate avoids a wasted `next → terminal` hop when no custom plugin
 * observes the slot.
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

/**
 * Middleware wrapper around {@link defaultCompactionTerminal}. Registered via
 * {@link defaultCompactionPlugin} so tests that compose middleware through the
 * registry (rather than passing a terminal to `runPipeline` directly) see a
 * working no-op default. In production the orchestrator passes
 * {@link defaultCompactionTerminal} as the terminal and this middleware is
 * never hit.
 */
const defaultCompactionMiddleware: Middleware<
  CompactionArgs,
  CompactionResult
> = async function defaultCompaction(args, next, ctx) {
  // Invoke `next` so any custom plugins layered outside us still run; when
  // we're the only middleware, `next` is the terminal and returns the real
  // compaction output.
  void ctx;
  return next(args);
};

/**
 * Manifest + middleware wiring for the default compaction plugin. The
 * registration happens in `daemon/external-plugins-bootstrap.ts` before
 * {@link bootstrapPlugins} fires plugin `init()` hooks.
 */
export const defaultCompactionPlugin: Plugin = {
  manifest: {
    name: DEFAULT_COMPACTION_PLUGIN_NAME,
    version: "1.0.0",
    requires: {
      pluginRuntime: "v1",
      compactionApi: "v1",
    },
  },
  middleware: {
    compaction: defaultCompactionMiddleware,
  },
};
