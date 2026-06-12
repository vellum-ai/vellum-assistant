/**
 * Workflow orchestration engine — `executeWorkflow`.
 *
 * Runs an assistant-authored workflow script in the QuickJS sandbox
 * ({@link createWorkflowSandbox}) and fans it out to many parallel ephemeral
 * leaf agents ({@link runLeaf}). The engine ties together four already-merged
 * building blocks:
 *
 *  - **sandbox** (`sandbox.ts`) — runs the script SYNCHRONOUSLY. Host functions
 *    are asyncified: a host fn may return a promise, the VM suspends until it
 *    settles, and the script gets the value back directly (authors write
 *    `const r = agent(...)`, never `await agent(...)`). The VM is single-
 *    threaded: it is never inside two script callbacks at once, and a host
 *    function CANNOT synchronously re-enter the VM to invoke a script callback
 *    while it is itself suspended in asyncify. This is why `map`/`pipeline` are
 *    JS prelude helpers (built on `parallel` purely in the VM), not host fns.
 *  - **journal-store** (`journal-store.ts`) — `(runId, seq)` append-only log of
 *    every leaf call, for crash-resume replay.
 *  - **capabilities** (`capabilities.ts`) — the resolved tools/persona/
 *    host-function grants for the run (the single consent point).
 *  - **leaf-runner** (`leaf-runner.ts`) — the single-leaf primitive. Injected as
 *    a dependency so tests can pass a fake.
 *
 * ### Host API exposed to the script (synchronous from the script's view)
 *
 *  - `agent(prompt, opts?) -> result` — runs ONE leaf and returns its output.
 *  - `leaf(prompt, opts?) -> Spec` — a tagged descriptor (runs nothing); used
 *    inside `parallel`/`map` fan-out callbacks.
 *  - `parallel(specs) -> results[]` — runs the specs concurrently, capped at
 *    `config.maxConcurrentLeaves`, results in spec-array order; a failed leaf
 *    yields `null` (never throws). The core fan-out primitive.
 *  - `map(items, build) -> results[]` and
 *    `pipeline(items, ...stages) -> results[]` — JS prelude helpers over
 *    `parallel`. `pipeline` has a PER-STAGE BARRIER in v1: all of stage N
 *    completes before stage N+1 is built (the single-threaded VM cannot stream
 *    across stages).
 *  - `phase(title)`, `log(msg)` — forwarded to `onProgress`.
 *  - `args` — the verbatim run input.
 *  - `usage() -> { agentsSpawned, inputTokens, outputTokens }` — a read-only
 *    snapshot so scripts can self-moderate.
 *
 * Declared host functions from the manifest are injected by name; undeclared
 * ones are absent.
 *
 * ### Determinism & resume
 *
 * Each leaf call is assigned a `seq` from a monotonic counter incremented in
 * deterministic call order. For `parallel`, seqs are assigned across the spec
 * array in array order BEFORE any concurrency is launched, so completion order
 * cannot perturb seq. The `call_hash = sha256(deterministicStringify({ prompt,
 * opts }))`. On resume, a journal entry whose `(runId, seq)` is present and
 * whose `call_hash` matches is replayed from cache WITHOUT calling the leaf
 * runner (longest-unchanged-prefix replay).
 */

import { createHash } from "node:crypto";

import type { WorkflowsConfig } from "../config/schemas/workflows.js";
import type { TrustContext } from "../daemon/trust-context.js";
import { getLogger } from "../util/logger.js";
import type { ResolvedCapabilities } from "./capabilities.js";
import type * as JournalStore from "./journal-store.js";
import type { WorkflowRunStatus } from "./journal-store.js";
import type { runLeaf } from "./leaf-runner.js";
import { createWorkflowSandbox, WorkflowScriptError } from "./sandbox.js";

const log = getLogger("workflow-engine");

/** A progress event forwarded from the script's `phase`/`log` host calls. */
export type WorkflowProgressEvent =
  | { type: "phase"; title: string }
  | { type: "log"; message: string };

/** The journal-store surface the engine depends on (injectable for tests). */
export interface WorkflowJournal {
  appendJournalEntry: typeof JournalStore.appendJournalEntry;
  getJournalEntry: typeof JournalStore.getJournalEntry;
  getRun: typeof JournalStore.getRun;
  createRun: typeof JournalStore.createRun;
  updateRun: typeof JournalStore.updateRun;
  finishRun: typeof JournalStore.finishRun;
}

/** Static `meta` extracted from a workflow script. */
export interface WorkflowMeta {
  name: string;
  description: string;
}

export interface ExecuteWorkflowOptions {
  /** Stable run id; also the journal/resume key. */
  runId: string;
  /** The workflow script source (JS or TS). */
  scriptSource: string;
  /** Verbatim run input, exposed to the script as `args`. */
  args: unknown;
  /** Resolved capabilities (tools/persona/host fns) — the single consent point. */
  capabilities: ResolvedCapabilities;
  /** Engine caps and concurrency knobs. */
  config: WorkflowsConfig;
  /** Journal-store functions (injected so tests use a real store + temp DB). */
  journal: WorkflowJournal;
  /** Leaf runner (injected so tests pass a fake — no real provider call). */
  leafRunner: typeof runLeaf;
  /** Trust/auth context forwarded to every leaf. */
  trustContext: TrustContext;
  /** Receives `phase`/`log` progress events from the script. */
  onProgress?: (event: WorkflowProgressEvent) => void;
  /** Cooperative cancellation for the whole run. */
  signal?: AbortSignal;
}

export interface ExecuteWorkflowResult {
  status: WorkflowRunStatus;
  result: unknown;
  agentsSpawned: number;
  inputTokens: number;
  outputTokens: number;
}

/** Options passed by a script to `agent(...)` / `leaf(...)`. */
interface LeafCallOptions {
  schema?: unknown;
  label?: string;
  profile?: string;
  persona?: boolean;
  phase?: string;
}

/** Tagged descriptor returned by `leaf(...)` — runs nothing on its own. */
interface LeafSpec {
  __workflowSpec: true;
  prompt: string;
  opts: LeafCallOptions;
}

/** Sentinel thrown internally to unwind the script when the agent cap trips. */
class CapExceededSignal extends Error {
  constructor() {
    super("Workflow agent cap exceeded");
    this.name = "CapExceededSignal";
  }
}

/** Sentinel thrown internally to unwind the script on abort. */
class AbortedSignal extends Error {
  constructor() {
    super("Workflow aborted");
    this.name = "AbortedSignal";
  }
}

/**
 * Prelude evaluated in the VM before the user script. `map` and `pipeline` are
 * pure script-side helpers over the `parallel` host function — the VM is
 * single-threaded and a host fn cannot re-enter it mid-asyncify, so these
 * cannot be host functions. `pipeline` reduces over its stages with one
 * `parallel` per stage; because each `parallel` fully settles before the next
 * stage is built, v1 pipelining has a PER-STAGE BARRIER (no cross-stage
 * streaming). Each helper is wrapped in a getter-free assignment so a script
 * cannot accidentally shadow it before use.
 */
const SCRIPT_PRELUDE = `
const map = (items, build) => parallel(items.map((it, i) => __toSpec(build(it, i))));
const pipeline = (items, ...stages) =>
  stages.reduce(
    (acc, stage) => parallel(acc.map((it, i) => __toSpec(stage(it, i)))),
    items,
  );
`;

/**
 * Normalize what a `map`/`pipeline` build callback returns into a leaf spec.
 * A build callback may return either a {@link LeafSpec} (from calling
 * `leaf(...)` itself, idiomatic) or a bare prompt string (sugar). `parallel`
 * accepts both, but normalizing here keeps the spec array uniform.
 */
const SCRIPT_PRELUDE_HELPERS = `
const __toSpec = (v) =>
  (v && typeof v === "object" && v.__workflowSpec === true) ? v : leaf(v);
`;

/**
 * Strip leading `export` keywords from top-level declarations. The sandbox runs
 * the script inside a synchronous function body where a top-level `export` is a
 * syntax error; an authored `export const meta = ...` (and any other top-level
 * `export const/let/var/function/class`) must become a plain local. Only matches
 * `export` at the start of a line (after optional indentation), so the word
 * "export" inside a string or expression is untouched.
 */
function stripTopLevelExports(scriptSource: string): string {
  return scriptSource.replace(
    /^(\s*)export\s+(const|let|var|function|class|async\s+function)\b/gm,
    "$1$2",
  );
}

/** Stable, sorted-key JSON stringify so hashes are insertion-order-independent. */
function deterministicStringify(value: unknown): string {
  return JSON.stringify(sortValue(value)) ?? "null";
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortValue((value as Record<string, unknown>)[key]);
  }
  return out;
}

function callHashOf(prompt: string, opts: LeafCallOptions): string {
  return createHash("sha256")
    .update(deterministicStringify({ prompt, opts }))
    .digest("hex");
}

/**
 * Extract the pure-literal `export const meta = { name, description }` from a
 * script. Rejects a computed/missing meta. The literal is parsed via
 * {@link JSON.parse} after light normalization — NOT `eval`/`Function` — so an
 * author cannot run code in the host process at extraction time (the script
 * source is untrusted; only the QuickJS sandbox may execute it). Anything that
 * isn't a plain `{ "name": "...", "description": "..." }` literal (template
 * strings, identifiers, function calls) fails to JSON-parse and is rejected.
 */
export function extractWorkflowMeta(scriptSource: string): WorkflowMeta {
  const match = scriptSource.match(
    /export\s+const\s+meta\s*=\s*(\{[\s\S]*?\})\s*;?/,
  );
  if (!match) {
    throw new WorkflowScriptError(
      "Workflow script must begin with a literal `export const meta = { name, description }`.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(literalToJson(match[1]!));
  } catch {
    throw new WorkflowScriptError(
      "Workflow script `meta` must be a plain object literal with string " +
        "`name` and `description` (no computed values, template strings, or calls).",
    );
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as Record<string, unknown>).name !== "string" ||
    typeof (parsed as Record<string, unknown>).description !== "string"
  ) {
    throw new WorkflowScriptError(
      "Workflow script `meta` must have string `name` and `description` fields.",
    );
  }
  const m = parsed as Record<string, unknown>;
  return { name: m.name as string, description: m.description as string };
}

/**
 * Normalize a restricted JS object literal into strict JSON without executing
 * it: convert single-quoted strings to double-quoted, quote bare identifier
 * keys, and drop a trailing comma. Any construct outside this grammar (a call,
 * a template literal, an identifier value) survives normalization as invalid
 * JSON and makes the subsequent `JSON.parse` throw — which is the rejection
 * path. This is a deliberately narrow normalizer, not a JS parser.
 */
function literalToJson(literal: string): string {
  return literal
    .replace(/'((?:[^'\\]|\\.)*)'/g, (_m, body: string) => {
      // Re-encode the unescaped string body as a JSON string literal.
      return JSON.stringify(body.replace(/\\'/g, "'"));
    })
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/,(\s*})/g, "$1");
}

/**
 * Run a workflow script and fan it out to parallel leaf agents, with journaled
 * resume and an agent cap. See the module doc for the host API and invariants.
 */
export async function executeWorkflow(
  opts: ExecuteWorkflowOptions,
): Promise<ExecuteWorkflowResult> {
  const {
    runId,
    scriptSource,
    args,
    capabilities,
    config,
    journal,
    leafRunner,
    trustContext,
    onProgress,
    signal,
  } = opts;

  const meta = extractWorkflowMeta(scriptSource);
  const scriptHash = createHash("sha256").update(scriptSource).digest("hex");

  // Idempotent run row: createRun on first execution, reuse on resume.
  const existing = journal.getRun(runId);
  if (!existing) {
    journal.createRun({
      id: runId,
      name: meta.name,
      scriptSource,
      scriptHash,
      args,
      capabilities,
      status: "running",
    });
  } else {
    // Re-running: re-open the row as running and reset terminal fields.
    journal.updateRun(runId, { status: "running" });
  }

  // --- Run-scoped mutable accounting ---------------------------------------
  let nextSeq = 0;
  let agentsSpawned = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let capExceeded = false;

  /** Persist live counters so `getRun` reports them mid-flight. */
  const flushCounters = (): void => {
    journal.updateRun(runId, { agentsSpawned, inputTokens, outputTokens });
  };

  /**
   * Run (or replay) a single leaf at a pre-assigned `seq`. Returns the leaf
   * output. On the agent cap or an abort, throws the corresponding sentinel to
   * unwind the whole script. A leaf-runner failure does NOT throw here — the
   * caller (`agent`/`parallel`) decides whether to surface or null it.
   */
  const runLeafAtSeq = async (
    seq: number,
    prompt: string,
    leafOpts: LeafCallOptions,
  ): Promise<{ output: unknown; failed: boolean }> => {
    if (signal?.aborted) throw new AbortedSignal();

    const hash = callHashOf(prompt, leafOpts);

    // Resume: replay a cached entry whose hash matches. Failures are journaled
    // with status "failed", so they are re-run rather than replayed as a hit.
    const cached = journal.getJournalEntry(runId, seq);
    if (cached && cached.callHash === hash && cached.status === "completed") {
      return { output: cached.result, failed: false };
    }

    // Agent cap: trip BEFORE launching, abort the whole run.
    if (agentsSpawned >= config.maxAgentsPerRun) {
      capExceeded = true;
      throw new CapExceededSignal();
    }
    agentsSpawned += 1;

    try {
      // A leaf is EITHER a schema leaf (structured output via forced
      // tool-choice — `schema` set, no tools) OR a tool leaf (free-form with
      // tools — no schema). `runLeaf` hard-errors if BOTH are passed. The
      // resolved capabilities always include a non-empty read-only baseline, so
      // forward `tools` only on the tool-leaf path; a schema leaf runs with none.
      const isSchemaLeaf = leafOpts.schema !== undefined;
      const result = await leafRunner({
        prompt,
        ...(leafOpts.label !== undefined ? { label: leafOpts.label } : {}),
        ...(isSchemaLeaf ? { schema: leafOpts.schema as never } : {}),
        ...(leafOpts.profile !== undefined
          ? { profile: leafOpts.profile }
          : {}),
        ...(isSchemaLeaf ? {} : { tools: capabilities.tools }),
        trustContext,
        ...(signal ? { signal } : {}),
      });
      inputTokens += result.inputTokens;
      outputTokens += result.outputTokens;
      flushCounters();
      journal.appendJournalEntry({
        runId,
        seq,
        callHash: hash,
        kind: "agent",
        request: { prompt, opts: leafOpts },
        result: result.output,
        status: "completed",
      });
      return { output: result.output, failed: false };
    } catch (err) {
      // A leaf failure is journaled as failed (so it is NOT replayed as a hit)
      // and surfaced to the caller, which decides to null or rethrow it.
      journal.appendJournalEntry({
        runId,
        seq,
        callHash: hash,
        kind: "agent",
        request: { prompt, opts: leafOpts },
        result: { error: err instanceof Error ? err.message : String(err) },
        status: "failed",
      });
      log.warn(
        { err, runId, seq, label: leafOpts.label },
        "Workflow leaf failed",
      );
      return { output: null, failed: true };
    }
  };

  // --- Host functions ------------------------------------------------------
  // `agent` runs one sequential leaf and surfaces failures (throws into the
  // script). `parallel` is the fan-out primitive: it null-coalesces failures.

  const hostAgent = async (
    promptArg: unknown,
    optsArg?: unknown,
  ): Promise<unknown> => {
    const prompt = String(promptArg);
    const leafOpts = normalizeLeafOpts(optsArg);
    const seq = nextSeq++;
    const { output, failed } = await runLeafAtSeq(seq, prompt, leafOpts);
    if (failed) {
      throw new WorkflowScriptError(
        `Workflow agent leaf${leafOpts.label ? ` "${leafOpts.label}"` : ""} failed.`,
      );
    }
    return output;
  };

  const hostLeaf = (promptArg: unknown, optsArg?: unknown): LeafSpec => ({
    __workflowSpec: true,
    prompt: String(promptArg),
    opts: normalizeLeafOpts(optsArg),
  });

  const hostParallel = async (specsArg: unknown): Promise<unknown[]> => {
    const specs = toSpecArray(specsArg);
    // Assign seqs in array order BEFORE launching concurrency, so completion
    // order cannot perturb the deterministic seq mapping.
    const assigned = specs.map((spec) => ({ spec, seq: nextSeq++ }));
    return runWithConcurrency(
      assigned,
      config.maxConcurrentLeaves,
      async ({ spec, seq }) => {
        const { output } = await runLeafAtSeq(seq, spec.prompt, spec.opts);
        // `parallel` never throws on a single leaf failure — it yields null.
        return output;
      },
    );
  };

  const hostPhase = (titleArg: unknown): void => {
    onProgress?.({ type: "phase", title: String(titleArg) });
  };
  const hostLog = (msgArg: unknown): void => {
    onProgress?.({ type: "log", message: String(msgArg) });
  };
  const hostUsage = (): {
    agentsSpawned: number;
    inputTokens: number;
    outputTokens: number;
  } => ({ agentsSpawned, inputTokens, outputTokens });

  // Always-available host functions.
  const hostFunctions: Record<
    string,
    (...a: unknown[]) => unknown | Promise<unknown>
  > = {
    agent: (p, o) => hostAgent(p, o),
    leaf: (p, o) => hostLeaf(p, o),
    parallel: (s) => hostParallel(s),
    phase: (t) => hostPhase(t),
    log: (m) => hostLog(m),
    usage: () => hostUsage(),
  };

  // Manifest-declared host functions are injected by name as no-op-safe stubs
  // only when explicitly granted. (Their concrete impls are bound by later PRs;
  // here we expose the names so an undeclared call is a ReferenceError and a
  // declared-but-unbound call fails loudly rather than silently.)
  for (const name of capabilities.hostFunctions) {
    if (name in hostFunctions) continue;
    hostFunctions[name] = () => {
      throw new WorkflowScriptError(
        `Host function "${name}" is declared but not bound in this engine build.`,
      );
    };
  }

  // The prelude defines `map`/`pipeline` over `parallel`; prepend it so the
  // user script can call them. The sandbox runs the script as a SYNCHRONOUS
  // function body, where a top-level `export` is a syntax error — strip the
  // `export` keyword(s) so `export const meta = ...` becomes a plain local.
  const fullScript = `${SCRIPT_PRELUDE_HELPERS}${SCRIPT_PRELUDE}\n${stripTopLevelExports(scriptSource)}`;

  const sandbox = createWorkflowSandbox({
    hostFunctions,
    ...(onProgress
      ? { onLog: (m) => onProgress({ type: "log", message: m }) }
      : {}),
    ...(signal ? { signal } : {}),
  });

  let status: WorkflowRunStatus;
  let result: unknown = null;

  try {
    result = await sandbox.run(fullScript, args);
    status = "completed";
  } catch (err) {
    if (capExceeded || err instanceof CapExceededSignal) {
      status = "cap_exceeded";
    } else if (signal?.aborted || err instanceof AbortedSignal) {
      status = "aborted";
    } else {
      status = "failed";
    }
    if (status === "failed") {
      log.warn({ err, runId }, "Workflow run failed");
    }
  }

  flushCounters();
  journal.finishRun(runId, {
    status,
    result: status === "completed" ? result : null,
    error:
      status === "failed"
        ? "Workflow script error"
        : status === "cap_exceeded"
          ? `Agent cap of ${config.maxAgentsPerRun} exceeded`
          : null,
  });

  return {
    status,
    result: status === "completed" ? result : null,
    agentsSpawned,
    inputTokens,
    outputTokens,
  };
}

function normalizeLeafOpts(optsArg: unknown): LeafCallOptions {
  if (!optsArg || typeof optsArg !== "object") return {};
  const o = optsArg as Record<string, unknown>;
  const out: LeafCallOptions = {};
  if (o.schema !== undefined) out.schema = o.schema;
  if (typeof o.label === "string") out.label = o.label;
  if (typeof o.profile === "string") out.profile = o.profile;
  if (typeof o.persona === "boolean") out.persona = o.persona;
  if (typeof o.phase === "string") out.phase = o.phase;
  return out;
}

function toSpecArray(specsArg: unknown): LeafSpec[] {
  if (!Array.isArray(specsArg)) {
    throw new WorkflowScriptError(
      "parallel(specs) requires an array of leaf specs.",
    );
  }
  return specsArg.map((spec, i) => {
    if (
      spec &&
      typeof spec === "object" &&
      (spec as Record<string, unknown>).__workflowSpec === true
    ) {
      return spec as LeafSpec;
    }
    // Sugar: a bare string is treated as a prompt-only spec.
    if (typeof spec === "string") {
      return { __workflowSpec: true, prompt: spec, opts: {} };
    }
    throw new WorkflowScriptError(
      `parallel(specs)[${i}] must be a leaf(...) spec or a prompt string.`,
    );
  });
}

/**
 * Run `tasks` with at most `limit` in flight, preserving INPUT ORDER in the
 * returned results array. A simple index-cursor worker pool: each worker pulls
 * the next index, runs it, and writes the result back at that index.
 */
async function runWithConcurrency<T, R>(
  tasks: T[],
  limit: number,
  run: (task: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(tasks.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, tasks.length || 1));

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= tasks.length) return;
      results[index] = await run(tasks[index]!);
    }
  };

  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}
