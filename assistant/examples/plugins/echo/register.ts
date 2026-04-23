/**
 * Echo plugin — observes every assistant pipeline and logs one structured
 * line per invocation to stderr.
 *
 * This plugin is bundled in the repository as an authoring reference. It is
 * not shipped with the assistant runtime; to try it locally, symlink this
 * directory into `~/.vellum/plugins/echo/` and restart the assistant. See
 * `README.md` in this directory for the full install recipe and
 * `assistant/docs/plugins.md` for general plugin authoring docs.
 *
 * ## IMPORTANT — imports below are REPO-LOCAL
 *
 * The relative imports from `../../../src/plugins/...` resolve correctly
 * only while this file lives inside the vellum-assistant repo at
 * `assistant/examples/plugins/echo/`. The path walks back to
 * `assistant/src/plugins/` so the example compiles against the assistant's
 * in-repo types.
 *
 * If you copy (rather than symlink) this directory to
 * `~/.vellum/plugins/echo/`, these imports will fail because
 * `~/.vellum/src/plugins/...` does not exist. The assistant does not
 * currently publish the plugin API as an npm package, so the only
 * zero-edit install path is the symlink recipe (Option 1 in README.md).
 *
 * For a standalone copy that lives outside the repo, you must either:
 * - Point the imports at an absolute path into a vellum-assistant checkout
 *   (`/path/to/vellum-assistant/assistant/src/plugins/registry.js`), or
 * - Rewrite the plugin to consume only the public types you need and drop
 *   the direct registry import in favor of your own entry-point wiring.
 *
 * See README.md "Option 2 — standalone copy" for the recommended
 * standalone-template adaptation steps.
 *
 * ## Design
 *
 * - Registers an observer middleware on every slot of `PipelineMiddlewareMap`.
 * - Each middleware records a start timestamp, calls `next(args)`, and on
 *   return — whether successful or not — emits one JSON line on `stderr` with
 *   `{ plugin, pipeline, durationMs, outcome }`. A `try { return await next(); }
 *   catch { outcome = "error"; rethrow; } finally { log(); }` pattern keeps the
 *   observation strictly non-interfering: the plugin never swallows errors
 *   and never rewrites arguments or results.
 * - Middleware is declared as async functions with stable names so the
 *   pipeline runner's `chain` log field attributes them correctly.
 *
 * The file exports no named symbols at module level — it only runs
 * `registerPlugin(echoPlugin)` as an import-time side effect, matching the
 * user-plugin-loader contract (see `assistant/src/plugins/user-loader.ts`).
 */

import { registerPlugin } from "../../../src/plugins/registry.js";
import type {
  CircuitBreakerArgs,
  CircuitBreakerResult,
  CompactionArgs,
  CompactionResult,
  EmptyResponseArgs,
  EmptyResponseResult,
  HistoryRepairArgs,
  HistoryRepairResult,
  LLMCallArgs,
  LLMCallResult,
  MemoryArgs,
  MemoryResult,
  OverflowReduceArgs,
  OverflowReduceResult,
  PersistArgs,
  PersistResult,
  Plugin,
  TitleArgs,
  TitleResult,
  TokenEstimateArgs,
  TokenEstimateResult,
  ToolErrorArgs,
  ToolErrorResult,
  ToolExecuteArgs,
  ToolExecuteResult,
  ToolResultTruncateArgs,
  ToolResultTruncateResult,
  TurnArgs,
  TurnResult,
} from "../../../src/plugins/types.js";

const PLUGIN_NAME = "echo";

/**
 * One line written to stderr per pipeline invocation. Kept intentionally
 * compact — pino-style JSON so operators can pipe the assistant's stderr
 * through `jq` without reshaping.
 */
function emit(
  pipelineName: string,
  startMs: number,
  outcome: "success" | "error",
): void {
  const durationMs = Math.round(performance.now() - startMs);
  const record = {
    plugin: PLUGIN_NAME,
    pipeline: pipelineName,
    durationMs,
    outcome,
  };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

/**
 * Factory for a pipeline-agnostic observer middleware. The returned function
 * carries a `name` so `runPipeline`'s `chain` log field attributes this
 * plugin's frame correctly. Error paths rethrow — the plugin is purely
 * observational and must never change the turn's outcome.
 */
function makeObserver<A, R>(
  pipelineName: string,
): (args: A, next: (args: A) => Promise<R>, _ctx: unknown) => Promise<R> {
  const fn = async function echoObserver(
    args: A,
    next: (args: A) => Promise<R>,
    _ctx: unknown,
  ): Promise<R> {
    const start = performance.now();
    let outcome: "success" | "error" = "success";
    try {
      return await next(args);
    } catch (err) {
      outcome = "error";
      throw err;
    } finally {
      emit(pipelineName, start, outcome);
    }
  };
  return fn;
}

/**
 * The echo plugin. Declares one middleware per slot in
 * `PipelineMiddlewareMap` — all thin observers produced by `makeObserver`.
 *
 * Manifest:
 * - `requires.pluginRuntime: "v1"` satisfies the registry's mandatory
 *   capability negotiation.
 * - `provides: {}` — the plugin exposes no capabilities to other plugins.
 * - No `requiresCredential` or `requiresFlag` — the plugin needs no external
 *   state and runs unconditionally.
 */
const echoPlugin: Plugin = {
  manifest: {
    name: PLUGIN_NAME,
    version: "0.1.0",
    provides: {},
    requires: { pluginRuntime: "v1" },
  },
  middleware: {
    turn: makeObserver<TurnArgs, TurnResult>("turn"),
    llmCall: makeObserver<LLMCallArgs, LLMCallResult>("llmCall"),
    toolExecute: makeObserver<ToolExecuteArgs, ToolExecuteResult>(
      "toolExecute",
    ),
    memoryRetrieval: makeObserver<MemoryArgs, MemoryResult>("memoryRetrieval"),
    historyRepair: makeObserver<HistoryRepairArgs, HistoryRepairResult>(
      "historyRepair",
    ),
    tokenEstimate: makeObserver<TokenEstimateArgs, TokenEstimateResult>(
      "tokenEstimate",
    ),
    compaction: makeObserver<CompactionArgs, CompactionResult>("compaction"),
    overflowReduce: makeObserver<OverflowReduceArgs, OverflowReduceResult>(
      "overflowReduce",
    ),
    persistence: makeObserver<PersistArgs, PersistResult>("persistence"),
    titleGenerate: makeObserver<TitleArgs, TitleResult>("titleGenerate"),
    toolResultTruncate: makeObserver<
      ToolResultTruncateArgs,
      ToolResultTruncateResult
    >("toolResultTruncate"),
    emptyResponse: makeObserver<EmptyResponseArgs, EmptyResponseResult>(
      "emptyResponse",
    ),
    toolError: makeObserver<ToolErrorArgs, ToolErrorResult>("toolError"),
    circuitBreaker: makeObserver<CircuitBreakerArgs, CircuitBreakerResult>(
      "circuitBreaker",
    ),
  },
};

// Side-effect registration — the user-plugin loader dynamic-imports this
// file and expects the registry to pick up the plugin during that import.
registerPlugin(echoPlugin);
