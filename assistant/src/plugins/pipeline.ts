/**
 * Plugin pipeline runner.
 *
 * A "pipeline" is a named chain of {@link Middleware}s wrapped around a
 * terminal handler (the original behavior that existed before plugins). The
 * runner composes the chain in onion order, runs it under an optional
 * per-pipeline timeout, and emits one structured log record per invocation
 * covering success, error, and timeout uniformly.
 *
 * Design doc: `.private/plans/agent-plugin-system.md` (PR 12 notes).
 *
 * Semantics:
 * - Onion composition — the first element of `middlewares` is the outermost
 *   wrapper; it sees the request first and the response last. Terminal runs
 *   in the middle.
 * - Strict-fail — there is NO `try/catch` around user middleware. Errors,
 *   including `PluginTimeoutError` from a breached budget, propagate to the
 *   caller. The `finally` block only handles logging, never error recovery.
 * - Timeout — when `timeoutMs` is a finite number, the invocation races a
 *   timer. A timeout rejection is a `PluginTimeoutError` carrying the
 *   pipeline name, the best-known offending plugin (from `ctx.pluginName`),
 *   and elapsed ms. When `timeoutMs` is `null`/`undefined`, no timer is
 *   armed — pipelines like `llmCall` and `toolExecute` rely on downstream
 *   timeouts instead.
 */

import type { Logger } from "pino";

import { getLogger } from "../util/logger.js";
import {
  type Middleware,
  type PipelineName,
  PluginTimeoutError,
  type TurnContext,
} from "./types.js";

// Side-effect import: register every first-party default plugin at module
// load so downstream consumers (production bootstrap AND tests that skip
// `bootstrapPlugins()`) observe a fully-populated registry by default.
// Every code path that calls `runPipeline` imports this module, so by the
// time the first pipeline runs the defaults are already in place. User
// plugins load via `loadUserPlugins()` inside `bootstrapPlugins()` (which
// runs AFTER all static side-effect imports), so the onion ordering
// (defaults inner, user middleware outer) across all 14 pipelines is
// preserved in production.
import "./defaults/index.js";

const moduleLogger = getLogger("plugin-pipeline");

// ─── Default timeouts ───────────────────────────────────────────────────────

/**
 * Default per-pipeline timeout budgets in milliseconds. A value of `null`
 * means the runner does NOT arm a timer — the pipeline relies on its
 * downstream for budgeting (e.g. `llmCall` defers to provider-level HTTP
 * timeouts; `toolExecute` defers to the per-tool timeout already enforced
 * by `ToolExecutor`).
 *
 * Callers pass the appropriate entry as `runPipeline`'s `timeoutMs` argument.
 * The design doc locks these numbers in; do not tweak without coordinating
 * a design update.
 */
export const DEFAULT_TIMEOUTS: Record<PipelineName, number | null> = {
  turn: null,
  llmCall: null,
  toolExecute: null,
  memoryRetrieval: 5000,
  historyRepair: 1000,
  tokenEstimate: 1000,
  compaction: 30000,
  overflowReduce: 30000,
  persistence: 10000,
  titleGenerate: 30000,
  toolResultTruncate: 1000,
  emptyResponse: 500,
  toolError: 500,
  circuitBreaker: 500,
};

// ─── Composition ────────────────────────────────────────────────────────────

/**
 * Compose an ordered list of {@link Middleware}s around a terminal handler
 * using onion semantics. The first element of `middlewares` is the outermost
 * layer.
 *
 * The returned function accepts `(args, ctx)` and runs the entire chain:
 * ```
 *   middlewares[0] → middlewares[1] → ... → terminal → ... → middlewares[1] → middlewares[0]
 * ```
 *
 * Middlewares that never call `next` short-circuit the chain — the terminal
 * and any deeper middleware are never invoked. Middlewares that throw abort
 * the chain; the error flows back out through any outer middleware unchanged
 * (no internal try/catch).
 */
export function composeMiddleware<A, R>(
  middlewares: ReadonlyArray<Middleware<A, R>>,
  terminal: (args: A) => Promise<R>,
): (args: A, ctx: TurnContext) => Promise<R> {
  return (args, ctx) => {
    // Walk back-to-front, wrapping each middleware around `next`. The last
    // middleware in the array wraps `terminal`; earlier entries wrap the
    // accumulated chain so they execute first.
    let next: (args: A) => Promise<R> = terminal;
    for (let i = middlewares.length - 1; i >= 0; i--) {
      const mw = middlewares[i]!;
      const downstream = next;
      next = (innerArgs: A) => mw(innerArgs, downstream, ctx);
    }
    return next(args);
  };
}

// ─── Runner ─────────────────────────────────────────────────────────────────

type PipelineLogRecord = {
  event: "plugin.pipeline";
  pipeline: PipelineName;
  chain: ReadonlyArray<string>;
  durationMs: number;
  outcome: "success" | "error" | "timeout";
  pluginName?: string;
  errorName?: string;
  errorMessage?: string;
  errorStack?: string;
  timeoutMs?: number;
  requestId: string;
  conversationId: string;
  turnIndex?: number;
};

/**
 * Best-effort detection of a pino-compatible logger on the `TurnContext`.
 *
 * `TurnContext` intentionally doesn't require a logger slot — most code paths
 * use the module-level logger. Some callers (notably plugin-scoped pipelines
 * in later PRs) may attach a child logger via `(ctx as any).logger`. We type
 * the field loosely to avoid coupling `TurnContext` to pino.
 */
function selectLogger(ctx: TurnContext): Logger {
  const maybe = (ctx as { logger?: unknown }).logger;
  if (maybe && typeof maybe === "object" && "info" in maybe) {
    return maybe as Logger;
  }
  return moduleLogger;
}

/**
 * Execute a named pipeline: compose middleware, run it under an optional
 * timeout, and emit one structured log record covering success, error, or
 * timeout uniformly.
 *
 * @param name        The pipeline identifier. Used for telemetry and error
 *                    attribution.
 * @param middlewares Ordered list of middlewares to wrap around `terminal`.
 *                    Names for the log `chain` are pulled from `Function.name`
 *                    (empty strings are kept so length always matches).
 * @param terminal    The original behavior. Runs when all middlewares call
 *                    `next`.
 * @param args        Pipeline-specific input payload.
 * @param ctx         Per-turn context. May carry an optional `logger` slot;
 *                    otherwise the module logger is used.
 * @param timeoutMs   Deadline in milliseconds. `null`/`undefined` disables
 *                    the timer entirely (inherits downstream timeouts).
 *
 * @throws {PluginTimeoutError} When `timeoutMs` is non-null and the chain
 *         exceeds the budget. `ctx.pluginName` (if set) is attached as the
 *         offending plugin.
 * @throws Any error produced by user middleware or the terminal — flows
 *         through unchanged.
 */
export async function runPipeline<A, R>(
  name: PipelineName,
  middlewares: ReadonlyArray<Middleware<A, R>>,
  terminal: (args: A) => Promise<R>,
  args: A,
  ctx: TurnContext,
  timeoutMs?: number | null,
): Promise<R> {
  const logger = selectLogger(ctx);
  const chain = middlewares.map((m) => m.name || "anonymous");
  const composed = composeMiddleware(middlewares, terminal);
  const start = performance.now();

  let outcome: "success" | "error" | "timeout" = "success";
  let thrown: unknown = undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) {
      const budget = timeoutMs;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new PluginTimeoutError(
              name,
              ctx.pluginName,
              Math.round(performance.now() - start),
            ),
          );
        }, budget);
      });
      return await Promise.race([composed(args, ctx), timeoutPromise]);
    }
    return await composed(args, ctx);
  } catch (err) {
    thrown = err;
    outcome = err instanceof PluginTimeoutError ? "timeout" : "error";
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    const durationMs = Math.round(performance.now() - start);
    const record: PipelineLogRecord = {
      event: "plugin.pipeline",
      pipeline: name,
      chain,
      durationMs,
      outcome,
      requestId: ctx.requestId,
      conversationId: ctx.conversationId,
    };
    if (ctx.turnIndex !== undefined) record.turnIndex = ctx.turnIndex;
    if (ctx.pluginName !== undefined) record.pluginName = ctx.pluginName;
    if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) {
      record.timeoutMs = timeoutMs;
    }
    if (thrown !== undefined) {
      if (thrown instanceof Error) {
        record.errorName = thrown.name;
        record.errorMessage = thrown.message;
        if (thrown.stack) record.errorStack = thrown.stack;
      } else {
        record.errorName = "NonError";
        record.errorMessage = String(thrown);
      }
    }
    logger.info(record, "plugin.pipeline");
  }
}
