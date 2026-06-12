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
import type { TrustContext } from "../daemon/trust-context.js";
import { wakeAgentForOpportunity } from "../runtime/agent-wake.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { getLogger } from "../util/logger.js";
import type { CapabilityManifest } from "./capabilities.js";
import { resolveCapabilities } from "./capabilities.js";
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
    // overwrite.
    this.deps.journal.createRun({
      id: runId,
      name: meta.name,
      scriptSource,
      scriptHash: createHash("sha256").update(scriptSource).digest("hex"),
      args: opts.args,
      capabilities,
      status: "running",
      conversationId: opts.conversationId ?? null,
    });

    const controller = new AbortController();
    this.inflight.set(runId, controller);

    // Fire-and-forget: the engine owns its own try/catch and always finishes
    // the run row. We never await it — `start` must return synchronously.
    void this.runToCompletion(
      runId,
      label,
      scriptSource,
      opts,
      capabilities,
      controller,
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
    opts: StartWorkflowOptions,
    capabilities: ReturnType<typeof resolveCapabilities>,
    controller: AbortController,
  ): Promise<void> {
    const config = this.deps.getConfig();
    try {
      const result = await this.deps.executeWorkflow({
        runId,
        scriptSource,
        args: opts.args,
        capabilities,
        config: config.workflows,
        journal: this.deps.journal,
        leafRunner: this.deps.leafRunner,
        trustContext: opts.trustContext,
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

      await this.injectCompletionSummary(opts, summary);
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
    opts: StartWorkflowOptions,
    summary: string,
  ): Promise<void> {
    if (!opts.conversationId) return;
    try {
      await this.deps.wake({
        conversationId: opts.conversationId,
        hint: summary,
        source: WORKFLOW_WAKE_SOURCE,
        trustContext: opts.trustContext,
      });
    } catch (err) {
      log.warn(
        { err, conversationId: opts.conversationId },
        "Workflow run manager: completion wake failed (non-fatal)",
      );
    }
  }
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
    lines.push(`Result: ${stringifyResult(result.result)}`);
  } else {
    lines.push(`Outcome: ${run?.error ?? result.status}`);
  }
  return lines.join("\n");
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
