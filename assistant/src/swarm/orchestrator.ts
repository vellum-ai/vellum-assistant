import type { SwarmPlan, SwarmTaskNode, SwarmTaskResult, SwarmExecutionSummary } from './types.js';
import type { SwarmLimits } from './limits.js';
import type { SwarmWorkerBackend } from './worker-backend.js';
import { runWorkerTask } from './worker-runner.js';
import type { Provider } from '../providers/types.js';
import { synthesizeResults } from './synthesizer.js';

export type OrchestratorEventKind =
  | 'plan_created'
  | 'task_started'
  | 'task_completed'
  | 'task_failed'
  | 'task_blocked'
  | 'synthesis_started'
  | 'done';

export interface OrchestratorEvent {
  kind: OrchestratorEventKind;
  taskId?: string;
  message?: string;
}

export type OrchestratorStatusCallback = (event: OrchestratorEvent) => void;

export interface ExecuteSwarmOptions {
  plan: SwarmPlan;
  limits: SwarmLimits;
  backend: SwarmWorkerBackend;
  workingDir: string;
  model?: string;
  /** Provider + model for final synthesis. */
  synthesisProvider?: Provider;
  synthesisModel?: string;
  onStatus?: OrchestratorStatusCallback;
  signal?: AbortSignal;
}

/**
 * Execute a validated swarm plan with parallel DAG scheduling,
 * bounded concurrency, and per-task retries.
 */
export async function executeSwarm(opts: ExecuteSwarmOptions): Promise<SwarmExecutionSummary> {
  const { plan, limits, backend, workingDir, model, onStatus, signal } = opts;
  const startTime = Date.now();

  // Safety net: reject cyclic plans even if the caller skipped validation
  const cyclePath = detectCycle(plan.tasks);
  if (cyclePath) {
    throw new Error(`Swarm plan contains a dependency cycle: ${cyclePath.join(' -> ')}`);
  }

  onStatus?.({ kind: 'plan_created', message: `Plan with ${plan.tasks.length} tasks` });

  const results = new Map<string, SwarmTaskResult>();
  const blocked = new Set<string>();

  // Build adjacency for dependency tracking
  const dependents = new Map<string, string[]>();
  for (const task of plan.tasks) {
    dependents.set(task.id, []);
  }
  for (const task of plan.tasks) {
    for (const dep of task.dependencies) {
      dependents.get(dep)?.push(task.id);
    }
  }

  // Determine initial ready tasks (no dependencies)
  const ready: SwarmTaskNode[] = [];
  const remaining = new Map<string, SwarmTaskNode>();
  const pendingDeps = new Map<string, Set<string>>();

  for (const task of plan.tasks) {
    remaining.set(task.id, task);
    if (task.dependencies.length === 0) {
      ready.push(task);
    } else {
      pendingDeps.set(task.id, new Set(task.dependencies));
    }
  }

  // Concurrent DAG executor — schedule tasks as soon as their prerequisites
  // finish, bounded by maxWorkers.  Unlike wave/batch execution, a newly
  // unblocked task can start immediately when a worker slot opens up rather
  // than waiting for the entire previous batch to complete.
  let activeCount = 0;
  let resolve: (() => void) | null = null;

  // Resolves whenever a running task completes (or the ready queue is refilled)
  // so the main loop can re-evaluate whether to launch more work.
  function signalProgress(): void {
    if (resolve) {
      const r = resolve;
      resolve = null;
      r();
    }
  }

  function waitForProgress(): Promise<void> {
    return new Promise<void>((r) => { resolve = r; });
  }

  function processResult(result: SwarmTaskResult): void {
    results.set(result.taskId, result);
    remaining.delete(result.taskId);

    if (result.status === 'completed') {
      onStatus?.({ kind: 'task_completed', taskId: result.taskId });
      // Immediately unblock dependents so they enter the ready queue
      for (const depId of dependents.get(result.taskId) ?? []) {
        const pending = pendingDeps.get(depId);
        if (pending) {
          pending.delete(result.taskId);
          if (pending.size === 0) {
            pendingDeps.delete(depId);
            const task = plan.tasks.find((t) => t.id === depId);
            if (task && !blocked.has(depId)) {
              ready.push(task);
            }
          }
        }
      }
    } else {
      onStatus?.({ kind: 'task_failed', taskId: result.taskId });
      blockDependents(result.taskId, dependents, blocked, onStatus);
    }
  }

  async function runTask(task: SwarmTaskNode): Promise<void> {
    onStatus?.({ kind: 'task_started', taskId: task.id });

    const depOutputs = task.dependencies
      .map((depId) => {
        const r = results.get(depId);
        return r ? { taskId: depId, summary: r.summary } : null;
      })
      .filter((d): d is { taskId: string; summary: string } => d != null);

    let result = await runWorkerTask({
      task,
      upstreamContext: plan.objective,
      dependencyOutputs: depOutputs,
      backend,
      workingDir,
      model,
      timeoutMs: limits.workerTimeoutSec * 1000,
      signal,
    });

    let retries = 0;
    while (result.status === 'failed' && retries < limits.maxRetriesPerTask && !signal?.aborted) {
      retries++;
      // Exponential backoff with ±25% jitter to prevent thundering herd
      const baseDelayMs = 1000 * Math.pow(2, retries - 1);
      const jitter = baseDelayMs * 0.25 * (2 * Math.random() - 1);
      await abortableSleep(baseDelayMs + jitter, signal);
      if (signal?.aborted) break;
      result = await runWorkerTask({
        task,
        upstreamContext: plan.objective,
        dependencyOutputs: depOutputs,
        backend,
        workingDir,
        model,
        timeoutMs: limits.workerTimeoutSec * 1000,
        signal,
      });
    }
    result.retryCount = retries;

    processResult(result);
  }

  while (ready.length > 0 || activeCount > 0) {
    if (signal?.aborted) break;

    // Launch as many ready tasks as worker slots allow
    while (ready.length > 0 && activeCount < limits.maxWorkers) {
      const task = ready.shift()!;
      activeCount++;
      // Fire-and-forget — completion is handled inside runTask.
      // .finally() ensures activeCount is decremented exactly once
      // regardless of where an error occurs (e.g. a throwing onStatus
      // callback inside processResult). .catch() suppresses the
      // unhandled rejection for fire-and-forget usage.
      runTask(task)
        .finally(() => {
          activeCount--;
          signalProgress();
        })
        .catch(() => {});
    }

    // Nothing left to launch and nothing running — we're done
    if (activeCount === 0 && ready.length === 0) break;

    // Wait until a running task completes (or a new task becomes ready)
    await waitForProgress();
  }

  // Let in-flight workers settle before finalizing — if we broke out of the
  // loop due to abort, workers may still be running and would otherwise emit
  // events (task_completed / task_failed) after the 'done' event.
  while (activeCount > 0) {
    await waitForProgress();
  }

  // Mark any remaining tasks that were never reached as blocked
  for (const [taskId] of remaining) {
    if (!results.has(taskId) && !blocked.has(taskId)) {
      blocked.add(taskId);
      onStatus?.({ kind: 'task_blocked', taskId });
    }
  }

  // Synthesize final answer (skip LLM synthesis when aborted, but still
  // build the markdown fallback so partial results are preserved)
  const allResults = Array.from(results.values());

  let finalAnswer: string;
  if (opts.synthesisProvider && !signal?.aborted) {
    onStatus?.({ kind: 'synthesis_started' });
    finalAnswer = await synthesizeResults({
      objective: plan.objective,
      results: allResults,
      provider: opts.synthesisProvider,
      model: opts.synthesisModel ?? 'claude-sonnet-4-6',
    });
  } else {
    if (!signal?.aborted) onStatus?.({ kind: 'synthesis_started' });
    finalAnswer = buildMarkdownFallback(plan.objective, allResults);
  }

  const totalDurationMs = Date.now() - startTime;
  onStatus?.({ kind: 'done', message: `Completed in ${totalDurationMs}ms` });

  return {
    objective: plan.objective,
    plan,
    results: allResults,
    finalAnswer,
    stats: {
      totalTasks: plan.tasks.length,
      completed: allResults.filter((r) => r.status === 'completed').length,
      failed: allResults.filter((r) => r.status === 'failed').length,
      blocked: blocked.size,
      totalDurationMs,
    },
  };
}

function blockDependents(
  taskId: string,
  dependents: Map<string, string[]>,
  blocked: Set<string>,
  onStatus?: OrchestratorStatusCallback,
): void {
  for (const depId of dependents.get(taskId) ?? []) {
    if (!blocked.has(depId)) {
      blocked.add(depId);
      onStatus?.({ kind: 'task_blocked', taskId: depId });
      blockDependents(depId, dependents, blocked, onStatus);
    }
  }
}

/**
 * DFS-based cycle detection. Returns the cycle path (e.g. ['a', 'b', 'c', 'a'])
 * if a cycle exists, or null if the graph is a valid DAG.
 */
function detectCycle(tasks: SwarmTaskNode[]): string[] | null {
  const adj = new Map<string, string[]>();
  for (const t of tasks) {
    adj.set(t.id, []);
  }
  for (const t of tasks) {
    for (const dep of t.dependencies) {
      // Edge from dep -> t.id (dep must finish before t)
      adj.get(dep)?.push(t.id);
    }
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const t of tasks) color.set(t.id, WHITE);

  const parent = new Map<string, string>();

  // Iterative DFS to avoid stack overflow on deep acyclic chains
  for (const t of tasks) {
    if (color.get(t.id) !== WHITE) continue;

    const stack: Array<{ node: string; neighborIdx: number }> = [
      { node: t.id, neighborIdx: 0 },
    ];
    color.set(t.id, GRAY);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbors = adj.get(frame.node) ?? [];

      if (frame.neighborIdx >= neighbors.length) {
        // All neighbors visited — mark node as fully processed
        color.set(frame.node, BLACK);
        stack.pop();
        continue;
      }

      const neighbor = neighbors[frame.neighborIdx];
      frame.neighborIdx++;

      if (color.get(neighbor) === GRAY) {
        // Back edge found — reconstruct cycle path
        const cycle = [neighbor];
        for (let i = stack.length - 1; i >= 0; i--) {
          cycle.push(stack[i].node);
          if (stack[i].node === neighbor) break;
        }
        cycle.reverse();
        return cycle;
      }

      if (color.get(neighbor) === WHITE) {
        parent.set(neighbor, frame.node);
        color.set(neighbor, GRAY);
        stack.push({ node: neighbor, neighborIdx: 0 });
      }
    }
  }
  return null;
}

/** Resolves after `ms` milliseconds, or immediately if the signal fires first. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}

function buildMarkdownFallback(objective: string, results: SwarmTaskResult[]): string {
  const lines: string[] = [`## Swarm Results: ${objective}`, ''];

  const completed = results.filter((r) => r.status === 'completed');
  const failed = results.filter((r) => r.status === 'failed');

  if (completed.length > 0) {
    lines.push('### Completed Tasks');
    for (const r of completed) {
      lines.push(`- **${r.taskId}**: ${r.summary}`);
    }
    lines.push('');
  }

  if (failed.length > 0) {
    lines.push('### Failed Tasks');
    for (const r of failed) {
      lines.push(`- **${r.taskId}**: ${r.summary}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
