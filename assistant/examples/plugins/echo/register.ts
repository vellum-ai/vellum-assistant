/**
 * Echo plugin — observes every assistant pipeline and logs one structured
 * line per invocation to stderr.
 *
 * Bundled in the repository as an authoring reference. To try it locally,
 * symlink (or copy) this directory into `<workspaceDir>/plugins/echo/` and
 * restart the assistant. See `README.md` in this directory for the install
 * recipe and `assistant/docs/plugins.md` for general plugin authoring docs.
 *
 * ## Runtime contract
 *
 * The plugin imports `registerPlugin` from `@vellumai/plugin-api`. At
 * daemon startup, a workspace shim is materialized under
 * `<workspaceDir>/node_modules/@vellumai/plugin-api/` that re-binds the
 * runtime values from the assistant binary's embedded plugin-api
 * namespace. This means the same plugin file works whether the daemon
 * is running from source or as a `bun --compile` binary — module
 * identity is preserved by routing every binding through one
 * `globalThis`-anchored namespace.
 *
 * Type-only imports (`Plugin` from `@vellumai/plugin-api`, the
 * pipeline-argument types from `assistant/src/plugins/types.js`) erase
 * before runtime, so they have no module-identity effect. Today the
 * pipeline-argument types still live inside the assistant source tree
 * and the example imports them via a relative path — that works while
 * this file lives in the vellum-assistant checkout. A future PR will
 * migrate the pipeline-argument types into `@vellumai/plugin-api` so
 * standalone-copy installs can drop the relative `import type` lines
 * entirely.
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

import { type Plugin, registerPlugin } from "@vellumai/plugin-api";

// Pipeline arg/result types still live in the assistant's internal types
// module. They're erased at runtime, so importing them by relative path is
// safe for the in-repo install model used by this example. A future PR
// will migrate them into `@vellumai/plugin-api` so this block can collapse
// to a single import from the public package.
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
 * - Host-compat range lives in `package.json` under
 *   `peerDependencies["@vellumai/plugin-api"]`. The external-plugin loader
 *   validates it against the running assistant version via
 *   `semver.satisfies()` before this file is even imported.
 * - No `requiresCredential` or `requiresFlag` — the plugin needs no external
 *   state and runs unconditionally.
 */
const echoPlugin: Plugin = {
  manifest: {
    name: PLUGIN_NAME,
    version: "0.1.0",
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
