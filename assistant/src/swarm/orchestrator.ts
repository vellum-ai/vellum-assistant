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

  // Process tasks with bounded concurrency
  while (ready.length > 0 || isAnyRunning()) {
    if (signal?.aborted) break;

    // Launch up to maxWorkers tasks
    const batch = ready.splice(0, limits.maxWorkers);

    const promises = batch.map(async (task) => {
      onStatus?.({ kind: 'task_started', taskId: task.id });

      const depOutputs = task.dependencies
        .map((depId) => {
          const r = results.get(depId);
          return r ? { taskId: depId, summary: r.summary } : null;
        })
        .filter((d): d is { taskId: string; summary: string } => d !== null);

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

      // Retry loop
      let retries = 0;
      while (result.status === 'failed' && retries < limits.maxRetriesPerTask) {
        retries++;
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

      return result;
    });

    const batchResults = await Promise.all(promises);

    for (const result of batchResults) {
      results.set(result.taskId, result);
      remaining.delete(result.taskId);

      if (result.status === 'completed') {
        onStatus?.({ kind: 'task_completed', taskId: result.taskId });
        // Unblock dependents
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
        // Block all transitive dependents
        blockDependents(result.taskId, dependents, blocked, onStatus);
      }
    }
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
      model: opts.synthesisModel ?? 'claude-sonnet-4-5-20250929',
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

  // Placeholder — there's no true async tracking in this sync loop,
  // but the structure supports it.
  function isAnyRunning(): boolean {
    return false;
  }
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
