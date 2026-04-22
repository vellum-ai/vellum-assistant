/**
 * Default `memoryRetrieval` plugin.
 *
 * Encapsulates the three retrievals the agent loop performs before building
 * the runtime-injection block for a turn:
 *
 * 1. **PKB context** via {@link readPkbContext} — always-loaded workspace
 *    notes (INDEX.md, essentials.md, …) that precede the user's message.
 * 2. **NOW.md scratchpad** via {@link readNowScratchpad} — the short
 *    user-maintained note the assistant keeps up to date.
 * 3. **Memory graph** via {@link ConversationGraphMemory.prepareMemory} —
 *    dispatches to context-load or per-turn retrieval depending on
 *    initialization state; gated on the actor being trusted (guardian).
 *
 * The default plugin registers a pass-through middleware so the pipeline
 * runner always has at least one entry and downstream telemetry observes a
 * deterministic chain. The actual retrieval runs in the terminal supplied
 * by the agent loop; centralizing the helper here (as
 * {@link runDefaultMemoryRetrieval}) makes it trivial for a plugin to
 * fall back to the default behavior by calling this helper from its own
 * middleware.
 *
 * See `.private/plans/agent-plugin-system.md` PR 20 for the containing
 * milestone.
 */

import type { AssistantConfig } from "../../config/schema.js";
import {
  readNowScratchpad,
  readPkbContext,
} from "../../daemon/conversation-runtime-assembly.js";
import type { ServerMessage } from "../../daemon/message-protocol.js";
import type { ConversationGraphMemory } from "../../memory/graph/conversation-graph-memory.js";
import type { Message } from "../../providers/types.js";
import { registerPlugin } from "../registry.js";
import {
  type MemoryArgs,
  type MemoryResult,
  type Middleware,
  type Plugin,
  PluginExecutionError,
} from "../types.js";

/**
 * Discriminator the agent loop uses to narrow `MemoryResult.memoryGraphBlocks`
 * back into the full {@link GraphMemoryPayload} shape. Plugins that substitute
 * their own memory blocks without setting this marker will fall through the
 * agent loop's graph-result consumption path — which is the intended escape
 * hatch for custom retrievers.
 */
export const DEFAULT_MEMORY_GRAPH_KIND = "default.graph" as const;

/**
 * Shape of the single block the default memory-graph retriever emits.
 *
 * Mirrors the object returned by
 * {@link ConversationGraphMemory.prepareMemory} — the agent loop consumes
 * every field downstream (PKB query vectors, metrics persistence, memory
 * event emission). Kept as a concrete type here so both the terminal and the
 * agent loop can share one import.
 */
export interface GraphMemoryPayload {
  readonly kind: typeof DEFAULT_MEMORY_GRAPH_KIND;
  readonly result: Awaited<
    ReturnType<ConversationGraphMemory["prepareMemory"]>
  >;
}

/**
 * External state the default retriever needs but the pipeline args cannot
 * carry (conversation-scoped graph handle, per-turn abort signal, event
 * sink, live message list). Passed as a second argument to
 * {@link runDefaultMemoryRetrieval} rather than threaded through
 * {@link MemoryArgs} to keep the plugin-facing pipeline surface minimal.
 */
export interface DefaultMemoryRetrievalDeps {
  /** Live message list for this turn (pre-injection). */
  readonly messages: Message[];
  /** Per-conversation memory graph handle. */
  readonly graphMemory: ConversationGraphMemory;
  /** Assistant config snapshot. */
  readonly config: AssistantConfig;
  /** Abort signal wired to the turn's cancellation budget. */
  readonly abortSignal: AbortSignal;
  /** Event sink used by the graph retriever (memory_status events). */
  readonly onEvent: (msg: ServerMessage) => void;
  /** True when the actor for this turn is trusted (guardian-class). */
  readonly isTrustedActor: boolean;
}

/**
 * Run the default retrieval. Always returns a {@link MemoryResult}; skips
 * the memory-graph call entirely when the actor is not trusted (matches the
 * prior agent-loop gate).
 *
 * The returned `memoryGraphBlocks` is either empty (when the actor is not
 * trusted) or a single {@link GraphMemoryPayload} wrapping the graph
 * retriever's full output. The agent loop narrows via
 * {@link DEFAULT_MEMORY_GRAPH_KIND} to consume it.
 */
export async function runDefaultMemoryRetrieval(
  _args: MemoryArgs,
  deps: DefaultMemoryRetrievalDeps,
): Promise<MemoryResult> {
  // NOW.md and PKB are read unconditionally — the agent loop decides
  // whether to inject them based on first-turn / post-compaction gating.
  const pkbContent = readPkbContext();
  const nowContent = readNowScratchpad();

  if (!deps.isTrustedActor) {
    // Untrusted actors skip memory-graph retrieval entirely — preserves the
    // pre-plugin gate that lived inline in `conversation-agent-loop.ts`.
    return {
      pkbContent,
      nowContent,
      memoryGraphBlocks: [],
    };
  }

  const graphResult = await deps.graphMemory.prepareMemory(
    deps.messages,
    deps.config,
    deps.abortSignal,
    deps.onEvent,
  );

  const payload: GraphMemoryPayload = {
    kind: DEFAULT_MEMORY_GRAPH_KIND,
    result: graphResult,
  };

  return {
    pkbContent,
    nowContent,
    memoryGraphBlocks: [payload],
  };
}

/**
 * Narrow a {@link MemoryResult} memory-graph block back into the full
 * {@link GraphMemoryPayload} the default retriever emits. Returns `null` when
 * the pipeline output came from a custom retriever (no blocks, or a block
 * without the {@link DEFAULT_MEMORY_GRAPH_KIND} discriminator).
 *
 * The agent loop uses this helper to decide whether to run its downstream
 * graph-result consumption path (query-vector propagation, metric
 * persistence, memory-event emission). Custom retrievers that skip that
 * path are expected to handle their own side effects inside their
 * middleware.
 */
export function asDefaultGraphPayload(
  blocks: ReadonlyArray<unknown>,
): GraphMemoryPayload | null {
  const first = blocks[0];
  if (
    first != null &&
    typeof first === "object" &&
    "kind" in first &&
    (first as { kind?: unknown }).kind === DEFAULT_MEMORY_GRAPH_KIND
  ) {
    return first as GraphMemoryPayload;
  }
  return null;
}

/**
 * Default `memoryRetrieval` middleware — a pure pass-through.
 *
 * Keeping a real middleware registered (rather than an empty list) makes
 * the pipeline observable in `plugin.pipeline` logs with a non-empty
 * `chain` field and lets third-party plugins rely on the default slot
 * being present even when nothing is overriding it. The work happens in
 * the terminal supplied by the agent loop, which calls
 * {@link runDefaultMemoryRetrieval}.
 */
const defaultMemoryRetrievalMiddleware: Middleware<MemoryArgs, MemoryResult> =
  async function defaultMemoryRetrieval(args, next) {
    return next(args);
  };

/**
 * Default plugin exposing the `memoryRetrieval` pipeline slot. Registered
 * by {@link registerDefaultMemoryRetrievalPlugin} from the plugin
 * bootstrap wiring so ordering is deterministic across boots.
 */
export const defaultMemoryRetrievalPlugin: Plugin = {
  manifest: {
    name: "default-memory-retrieval",
    version: "0.0.1",
    requires: { pluginRuntime: "v1", memoryApi: "v1" },
  },
  middleware: {
    memoryRetrieval: defaultMemoryRetrievalMiddleware,
  },
};

// Module-load side effect: register this default at import time so
// downstream consumers (including tests that skip `bootstrapPlugins()`)
// observe a populated registry by default. Idempotent via the swallowed
// duplicate-name check. Kept local to this module (rather than iterating
// an array in `defaults/index.ts`) so the registration only references
// the already-initialized `defaultMemoryRetrievalPlugin` identifier —
// avoiding a TDZ crash when tests `mock.module(...)` a dependency of any
// other default plugin and directly import this file.
try {
  registerPlugin(defaultMemoryRetrievalPlugin);
} catch (err) {
  if (
    err instanceof PluginExecutionError &&
    err.message.includes("already registered")
  ) {
    // already registered — expected when both index.ts and the direct
    // file are imported in the same process
  } else {
    throw err;
  }
}
