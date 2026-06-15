/**
 * Lifecycle layer for the workflow orchestration engine.
 *
 * The {@link WorkflowRunManager} is the surface the workflow tool, scheduler,
 * and routes (later PRs) drive. It owns everything the raw {@link executeWorkflow}
 * engine deliberately does NOT:
 *
 *  - **Feature-flag gate.** `start` hard-fails with {@link WorkflowsDisabledError}
 *    when the `workflows` flag is off, BEFORE any engine code path is reachable.
 *  - **Concurrent-run cap.** At most `config.workflows.maxConcurrentRuns` runs
 *    may be in flight; the (N+1)th `start` throws {@link WorkflowRunCapError}.
 *  - **Async launch.** `start` resolves capabilities, creates the journal run
 *    row, kicks off {@link executeWorkflow} WITHOUT awaiting it, and returns the
 *    `runId` immediately. Progress and completion are surfaced out-of-band.
 *  - **Progress + completion events.** The engine's `onProgress` callback is
 *    republished as `workflow_progress` server messages; on completion a
 *    `workflow_completed` message is published. Both go through the shared
 *    `broadcastMessage` / event hub.
 *  - **Completion injection.** On completion, a human-readable summary is
 *    surfaced back into the originating conversation via
 *    {@link wakeAgentForOpportunity} — the same mechanism scheduled tasks and
 *    background shell jobs use to report finished background work to a
 *    conversation.
 *
 * `status` and `list` are thin reads over the journal store (the engine flushes
 * live counts to the run row, so `getRun` is the single source of truth).
 */

import { createHash, randomUUID } from "node:crypto";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import type { AssistantConfig } from "../config/schema.js";
import {
  FALLBACK_TURN_TRUST,
  type TrustContext,
} from "../daemon/trust-context.js";
import { wakeAgentForOpportunity } from "../runtime/agent-wake.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { getLogger } from "../util/logger.js";
import type { CapabilityManifest } from "./capabilities.js";
import {
  normalizeCapabilityManifest,
  resolveCapabilities,
} from "./capabilities.js";
import {
  executeWorkflow,
  extractWorkflowMeta,
  WorkflowNotFoundError,
} from "./engine.js";
import type { WorkflowRun } from "./journal-store.js";
import * as journalStore from "./journal-store.js";
import { runLeaf } from "./leaf-runner.js";
import * as library from "./library.js";

const log = getLogger("workflow-run-manager");

/** Source tag for the completion wake (shows up in the wake's structured log). */
const WORKFLOW_WAKE_SOURCE = "workflow_completed";

/** Thrown by `start` when the `workflows` feature flag is disabled. */
export class WorkflowsDisabledError extends Error {
  readonly code = "workflows_disabled" as const;
  constructor() {
    super("Workflows are not enabled.");
    this.name = "WorkflowsDisabledError";
  }
}

/** Thrown by `start` when the concurrent-run cap is already reached. */
export class WorkflowRunCapError extends Error {
  readonly code = "workflow_run_cap_exceeded" as const;
  constructor(readonly limit: number) {
    super(
      `Cannot start workflow run: ${limit} run(s) are already in flight ` +
        `(maxConcurrentRuns).`,
    );
    this.name = "WorkflowRunCapError";
  }
}

/**
 * Thrown by `resume` when the target run cannot be resumed: it does not exist,
 * is already in a terminal-but-not-resumable state, or is currently in flight.
 * Only an `interrupted` run (a `running` row reconciled at startup after a
 * crash) is resumable.
 */
export class WorkflowResumeNotPossibleError extends Error {
  readonly code = "workflow_resume_not_possible" as const;
  constructor(
    readonly runId: string,
    readonly reason: "not_found" | "not_interrupted" | "in_flight",
    readonly status?: WorkflowRun["status"],
  ) {
    super(
      reason === "not_found"
        ? `Workflow run ${runId} not found.`
        : reason === "in_flight"
          ? `Workflow run ${runId} is already in flight.`
          : `Workflow run ${runId} is not resumable (status: ${status}). ` +
            `Only interrupted runs can be resumed.`,
    );
    this.name = "WorkflowResumeNotPossibleError";
  }
}

/**
 * Start a run from EITHER an inline `scriptSource` OR a saved workflow `name`
 * (exactly one). When `name` is given the source is resolved from the saved
 * workflow library; an unknown name throws {@link WorkflowNotFoundError}.
 */
export type StartWorkflowOptions = StartWorkflowCommon &
  (
    | { scriptSource: string; name?: undefined }
    | { name: string; scriptSource?: undefined }
  );

interface StartWorkflowCommon {
  /** Verbatim run input, exposed to the script as `args`. */
  args: unknown;
  /** Per-run capability declaration (the single consent point). */
  manifest: CapabilityManifest;
  /**
   * Conversation that originated the run; receives the completion summary via
   * an agent wake. Omit for runs with no originating conversation (e.g. a
   * scheduled run with no chat surface) — the summary is then events-only.
   */
  conversationId?: string;
  /** Human-readable label for display; defaults to the run id. */
  label?: string;
  /** Trust/auth context forwarded to every leaf. */
  trustContext: TrustContext;
}

/**
 * Dependencies injected for testing. Production callers omit this entirely and
 * rely on the real engine, leaf runner, journal store, config, and wake.
 */
export interface WorkflowRunManagerDeps {
  executeWorkflow: typeof executeWorkflow;
  leafRunner: typeof runLeaf;
  journal: typeof journalStore;
  getConfig: () => AssistantConfig;
  isFlagEnabled: (config: AssistantConfig) => boolean;
  wake: typeof wakeAgentForOpportunity;
  broadcast: typeof broadcastMessage;
  newRunId: () => string;
  /** Resolve a saved workflow's source by name (for `start({ name })`). */
  getWorkflow: typeof library.getWorkflow;
}

function defaultDeps(): WorkflowRunManagerDeps {
  return {
    executeWorkflow,
    leafRunner: runLeaf,
    journal: journalStore,
    getConfig,
    isFlagEnabled: (config) =>
      isAssistantFeatureFlagEnabled("workflows", config),
    wake: wakeAgentForOpportunity,
    broadcast: broadcastMessage,
    newRunId: () => randomUUID(),
    getWorkflow: library.getWorkflow,
  };
}

/**
 * Owns the lifecycle of workflow runs. One instance per daemon (see
 * {@link getWorkflowRunManager}); tests construct their own with injected deps.
 */
export class WorkflowRunManager {
  private readonly deps: WorkflowRunManagerDeps;
  /** runId → AbortController for every currently in-flight run. */
  private readonly inflight = new Map<string, AbortController>();

  constructor(deps?: Partial<WorkflowRunManagerDeps>) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  /**
   * Launch a workflow run. Gates on the `workflows` flag and the concurrent-run
   * cap (both throw before any engine code is reachable), resolves capabilities,
   * creates the journal run row, and kicks off {@link executeWorkflow}
   * asynchronously. Returns the `runId` immediately — completion is surfaced via
   * events and a conversation wake.
   */
  start(opts: StartWorkflowOptions): { runId: string } {
    const config = this.deps.getConfig();
    if (!this.deps.isFlagEnabled(config)) {
      throw new WorkflowsDisabledError();
    }

    const limit = config.workflows.maxConcurrentRuns;
    if (this.inflight.size >= limit) {
      throw new WorkflowRunCapError(limit);
    }

    // Resolve the script source: either inline (`scriptSource`) or by name from
    // the saved-workflow library (`name`). An unknown saved name throws
    // synchronously, leaving no orphaned `running` row behind.
    const scriptSource = this.resolveScriptSource(opts);

    // Resolve capabilities and extract meta BEFORE creating the run row so a
    // manifest authoring error (unknown/forbidden tool) or a malformed script
    // `meta` surfaces synchronously to the caller and leaves no orphaned
    // `running` row behind.
    const capabilities = resolveCapabilities(opts.manifest);
    const meta = extractWorkflowMeta(scriptSource);

    const runId = this.deps.newRunId();
    const label = opts.label ?? meta.name;

    // Create the row up front (so `status`/`list` see it immediately) with the
    // same name + script hash the engine would compute, so its idempotent
    // re-open of the existing row is a true no-op rather than a divergent
    // overwrite. We persist the MANIFEST (a plain serializable grant), not the
    // resolved capabilities (which carry live Tool objects that don't survive a
    // round-trip), so a later `resume` can re-resolve it deterministically. We
    // also persist the originating TRUST CONTEXT (trust metadata, no secret
    // material) so a crash-orphaned `resume` reconstructs the exact trust class
    // the run started under — NEVER escalating to guardian on resume.
    this.deps.journal.createRun({
      id: runId,
      name: meta.name,
      scriptSource,
      scriptHash: createHash("sha256").update(scriptSource).digest("hex"),
      args: opts.args,
      capabilities: opts.manifest,
      status: "running",
      conversationId: opts.conversationId ?? null,
      trust: opts.trustContext,
    });

    const controller = new AbortController();
    this.inflight.set(runId, controller);

    // Fire-and-forget: the engine owns its own try/catch and always finishes
    // the run row. We never await it — `start` must return synchronously.
    void this.runToCompletion(
      runId,
      label,
      scriptSource,
      capabilities,
      controller,
      {
        args: opts.args,
        conversationId: opts.conversationId,
        trustContext: opts.trustContext,
      },
    );

    return { runId };
  }

  /**
   * Mark every `running` run `interrupted` at daemon startup. A row left in
   * `running` means the process died mid-run (the engine always finishes its
   * row on exit, so nothing else leaves one `running`). This makes the run
   * eligible for an explicit {@link resume}; it does NOT auto-resume (that would
   * be surprising and possibly unsafe). STATUS ONLY — accounting counters are
   * never touched (see {@link journalStore.markRunningAsInterrupted}). Returns
   * the number of runs reconciled.
   */
  reconcileOrphanedRuns(): number {
    return this.deps.journal.markRunningAsInterrupted();
  }

  /**
   * Resume an `interrupted` run with the SAME `runId`, re-invoking the engine so
   * it replays the journaled prefix and continues from the first changed/new
   * leaf. Reconstructs the run's inputs from the persisted row (script source,
   * args, capability manifest, conversation) and the trust context from the
   * persisted `trust` snapshot — so a resumed run NEVER runs with more trust
   * than it started under. Legacy rows with no persisted trust fall back to the
   * low-trust {@link FALLBACK_TURN_TRUST} (never guardian). Enforces the
   * `workflows` flag and the concurrent-run cap (a resume occupies a run slot).
   * Returns the `runId` immediately — completion is surfaced via events and a
   * conversation wake exactly like {@link start}.
   *
   * Throws {@link WorkflowResumeNotPossibleError} when the run is missing, not
   * `interrupted`, or already in flight.
   */
  resume(runId: string): { runId: string } {
    const config = this.deps.getConfig();
    if (!this.deps.isFlagEnabled(config)) {
      throw new WorkflowsDisabledError();
    }

    if (this.inflight.has(runId)) {
      throw new WorkflowResumeNotPossibleError(runId, "in_flight");
    }

    const run = this.deps.journal.getRun(runId);
    if (!run) {
      throw new WorkflowResumeNotPossibleError(runId, "not_found");
    }
    // Gate to `interrupted`: only a startup-reconciled crash leaves a resumable
    // row. A `running` row that is NOT in our in-flight map is a stale row from
    // a still-booting/other process — refuse rather than racing it.
    if (run.status !== "interrupted") {
      throw new WorkflowResumeNotPossibleError(
        runId,
        "not_interrupted",
        run.status,
      );
    }

    const limit = config.workflows.maxConcurrentRuns;
    if (this.inflight.size >= limit) {
      throw new WorkflowRunCapError(limit);
    }

    // Re-resolve capabilities from the persisted manifest (re-resolution throws
    // synchronously on an unknown/forbidden tool, leaving the row interrupted).
    // The engine re-validates the script's `meta` on re-invoke, so we don't
    // re-extract it here — the persisted `name` is the display label.
    const capabilities = resolveCapabilities(
      normalizeCapabilityManifest(run.capabilities),
    );
    const label = run.name ?? runId;
    const trustContext = reconstructResumeTrustContext(run.trust);

    // Flip back to `running` before launching so `status`/`list` reflect the
    // in-flight resume; the engine re-opens the same row idempotently.
    this.deps.journal.updateRun(runId, { status: "running" });

    const controller = new AbortController();
    this.inflight.set(runId, controller);

    void this.runToCompletion(
      runId,
      label,
      run.scriptSource,
      capabilities,
      controller,
      {
        args: run.args,
        conversationId: run.conversationId ?? undefined,
        trustContext,
      },
    );

    return { runId };
  }

  /**
   * Resolve the run's script source from `StartWorkflowOptions`: returns
   * `opts.scriptSource` verbatim, or — when `name` is given — the source of the
   * matching saved workflow. Throws {@link WorkflowNotFoundError} if the name
   * does not resolve.
   */
  private resolveScriptSource(opts: StartWorkflowOptions): string {
    if (opts.scriptSource !== undefined) return opts.scriptSource;
    const saved = this.deps.getWorkflow(opts.name);
    if (!saved) throw new WorkflowNotFoundError(opts.name);
    return saved.source;
  }

  /** Abort an in-flight run by signalling its {@link AbortController}. No-op for unknown/finished runs. */
  abort(runId: string): void {
    this.inflight.get(runId)?.abort();
  }

  /** Read the current run row (live counts + status), or null if unknown. */
  status(runId: string): WorkflowRun | null {
    return this.deps.journal.getRun(runId);
  }

  /** List runs newest-first, optionally filtered by status. */
  list(options?: {
    limit?: number;
    status?: WorkflowRun["status"];
  }): WorkflowRun[] {
    return this.deps.journal.listRuns({
      limit: options?.limit ?? 50,
      ...(options?.status ? { status: options.status } : {}),
    });
  }

  /** Number of currently in-flight runs (for tests / diagnostics). */
  inflightCount(): number {
    return this.inflight.size;
  }

  /**
   * Drive a single run to completion: stream progress events, await the engine,
   * publish completion, and inject the summary into the originating
   * conversation. Always clears the in-flight slot in a finally block so a cap
   * slot is never leaked even if the engine throws (it shouldn't — it owns its
   * own error handling — but defense in depth).
   */
  private async runToCompletion(
    runId: string,
    label: string,
    scriptSource: string,
    capabilities: ReturnType<typeof resolveCapabilities>,
    controller: AbortController,
    ctx: RunContext,
  ): Promise<void> {
    const config = this.deps.getConfig();
    try {
      const result = await this.deps.executeWorkflow({
        runId,
        scriptSource,
        args: ctx.args,
        capabilities,
        config: config.workflows,
        journal: this.deps.journal,
        leafRunner: this.deps.leafRunner,
        trustContext: ctx.trustContext,
        signal: controller.signal,
        onProgress: (event) => {
          const run = this.deps.journal.getRun(runId);
          const agentsSpawned = run?.agentsSpawned ?? 0;
          this.deps.broadcast({
            type: "workflow_progress",
            runId,
            label,
            agentsSpawned,
            ...(event.type === "phase"
              ? { phase: event.title }
              : { message: event.message }),
          });
        },
      });

      const summary = buildCompletionSummary(
        runId,
        label,
        result,
        this.deps.journal.getRun(runId),
      );

      this.deps.broadcast({
        type: "workflow_completed",
        runId,
        status: result.status,
        agentsSpawned: result.agentsSpawned,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        summary,
      });

      await this.injectCompletionSummary(ctx, summary);
    } catch (err) {
      // The engine finishes the run row even on internal errors, so this only
      // fires for an unexpected throw (e.g. a bug in the manager glue). Log and
      // move on — the in-flight slot is released in finally.
      log.error({ err, runId }, "Workflow run manager: run threw unexpectedly");
    } finally {
      this.inflight.delete(runId);
    }
  }

  /**
   * Surface the completion summary back into the originating conversation,
   * REUSING {@link wakeAgentForOpportunity} — the canonical "background job
   * finished, tell this conversation" path (shared with scheduled tasks and
   * background shell tools). Best-effort: a wake failure is logged, never
   * thrown (the run already completed; events already fired).
   */
  private async injectCompletionSummary(
    ctx: RunContext,
    summary: string,
  ): Promise<void> {
    if (!ctx.conversationId) return;
    try {
      await this.deps.wake({
        conversationId: ctx.conversationId,
        hint: summary,
        source: WORKFLOW_WAKE_SOURCE,
        trustContext: ctx.trustContext,
      });
    } catch (err) {
      log.warn(
        { err, conversationId: ctx.conversationId },
        "Workflow run manager: completion wake failed (non-fatal)",
      );
    }
  }
}

/**
 * The per-run inputs `runToCompletion` needs, decoupled from how the run was
 * launched. Both {@link WorkflowRunManager.start} (from `StartWorkflowOptions`)
 * and {@link WorkflowRunManager.resume} (from the persisted run row) build one.
 */
interface RunContext {
  args: unknown;
  conversationId: string | undefined;
  trustContext: TrustContext;
}

/** The trust classes a persisted trust snapshot may legitimately carry. */
const VALID_TRUST_CLASSES: ReadonlySet<TrustContext["trustClass"]> = new Set([
  "guardian",
  "trusted_contact",
  "unknown",
]);

/**
 * Reconstruct the {@link TrustContext} for a resumed run from its persisted
 * `trust` snapshot. This is the security boundary on resume: a run must NEVER
 * resume with more trust than it started under. When the snapshot is absent
 * (legacy rows written before the `trust_json` column existed) or unusable
 * (unparseable JSON, or a missing/unrecognized `trustClass`), we fall back to
 * the low-trust {@link FALLBACK_TURN_TRUST} — biased to `unknown` — matching the
 * start path's no-elevation discipline. We deliberately do NOT fall back to the
 * internal guardian context, which would clear the side-effect approval gate.
 */
function reconstructResumeTrustContext(persisted: unknown): TrustContext {
  if (persisted && typeof persisted === "object") {
    const candidate = persisted as Partial<TrustContext>;
    if (
      typeof candidate.trustClass === "string" &&
      VALID_TRUST_CLASSES.has(candidate.trustClass)
    ) {
      // The snapshot is a well-formed trust context — replay it verbatim.
      return candidate as TrustContext;
    }
  }
  return FALLBACK_TURN_TRUST;
}

/**
 * Build the human-readable completion summary injected into the originating
 * conversation and carried on the `workflow_completed` event. Reports the run's
 * terminal status, agent/token counts, and a result-or-error tail.
 */
function buildCompletionSummary(
  runId: string,
  label: string,
  result: Awaited<ReturnType<typeof executeWorkflow>>,
  run: WorkflowRun | null,
): string {
  const lines = [
    `[workflow "${label}" ${result.status}]`,
    `Run ${runId} finished with status: ${result.status}.`,
    `Agents spawned: ${result.agentsSpawned}. ` +
      `Tokens: ${result.inputTokens} in / ${result.outputTokens} out.`,
  ];
  if (result.status === "completed") {
    lines.push(`Result: ${truncateForSummary(stringifyResult(result.result))}`);
  } else {
    lines.push(`Outcome: ${run?.error ?? result.status}`);
  }
  return lines.join("\n");
}

/**
 * Max characters of a workflow result echoed into the completion summary. The
 * summary rides on the `workflow_completed` SSE event AND is injected into the
 * originating conversation via a wake, so an unbounded fan-out result (a large
 * array/object/string) could blow the event or prompt size limit. The full,
 * untruncated result is retained on the durable run row.
 */
const MAX_SUMMARY_RESULT_CHARS = 2000;

/** Bound a result tail for the summary; the full value stays on the run row. */
function truncateForSummary(s: string): string {
  if (s.length <= MAX_SUMMARY_RESULT_CHARS) return s;
  const omitted = s.length - MAX_SUMMARY_RESULT_CHARS;
  return (
    `${s.slice(0, MAX_SUMMARY_RESULT_CHARS)}… ` +
    `[truncated ${omitted} chars; full result on the workflow run record]`
  );
}

/** Compact a workflow result for the summary — JSON for objects, string otherwise. */
function stringifyResult(value: unknown): string {
  if (value == null) return "(no result)";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ── Process-level singleton ───────────────────────────────────────────────

let _instance: WorkflowRunManager | null = null;

/** Singleton {@link WorkflowRunManager} shared across the daemon. */
export function getWorkflowRunManager(): WorkflowRunManager {
  if (!_instance) {
    _instance = new WorkflowRunManager();
  }
  return _instance;
}
