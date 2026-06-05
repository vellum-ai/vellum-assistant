/**
 * Echo plugin — observes every assistant pipeline and logs one structured
 * line per invocation to stderr.
 *
 * Bundled in the repository as an authoring reference. To try it locally,
 * symlink (or copy) this directory into `<workspaceDir>/plugins/echo/` and
 * restart the assistant. See `README.md` in this directory for the install
 * recipe and `assistant/docs/plugins.md` for general plugin authoring docs.
 *
 * ## Runtime bridge
 *
 * The plugin reads `registerPlugin` from `globalThis.__vellumPluginRuntime`,
 * a stable handle the daemon attaches at startup. This lets the same plugin
 * file work whether the daemon is running from source (relative or absolute
 * imports would resolve to the daemon's modules) or as a `bun --compile`
 * binary (where absolute imports would load a disjoint disk copy with a
 * separate registry instance). The bridge is documented in
 * `assistant/src/plugins/external-api.ts`.
 *
 * Type imports below still come from the in-repo source tree. Types are
 * erased at runtime, so they don't affect module identity — but they only
 * resolve while this file lives inside the vellum-assistant checkout. For a
 * standalone-copy install, rewrite the `import type` paths to absolute paths
 * inside a checkout (or vendor only the types you need).
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

import type { VellumPluginRuntime } from "../../../src/plugins/external-api.js";
import type {
  CompactionArgs,
  CompactionResult,
  OverflowReduceArgs,
  OverflowReduceResult,
  Plugin,
} from "../../../src/plugins/types.js";

const runtime = (globalThis as { __vellumPluginRuntime?: VellumPluginRuntime })
  .__vellumPluginRuntime;
if (!runtime || runtime.version !== 1) {
  throw new Error(
    "echo plugin: globalThis.__vellumPluginRuntime is missing or has an unexpected version — install a recent assistant build",
  );
}
const { registerPlugin } = runtime;

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
    compaction: makeObserver<CompactionArgs, CompactionResult>("compaction"),
    overflowReduce: makeObserver<OverflowReduceArgs, OverflowReduceResult>(
      "overflowReduce",
    ),
  },
};

// Side-effect registration — the user-plugin loader dynamic-imports this
// file and expects the registry to pick up the plugin during that import.
registerPlugin(echoPlugin);
