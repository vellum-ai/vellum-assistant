/**
 * Swarm runtime types for multi-worker task orchestration.
 */

export type SwarmRole = 'router' | 'researcher' | 'coder' | 'reviewer';

export const VALID_SWARM_ROLES: readonly SwarmRole[] = ['router', 'researcher', 'coder', 'reviewer'] as const;

export interface SwarmTaskNode {
  /** Unique identifier within the plan. */
  id: string;
  /** Role that will execute this task. */
  role: SwarmRole;
  /** Human-readable objective for the worker. */
  objective: string;
  /** IDs of tasks that must complete before this one can start. */
  dependencies: string[];
}

export interface SwarmPlan {
  /** Top-level objective that was decomposed into tasks. */
  objective: string;
  /** Ordered list of tasks forming a DAG. */
  tasks: SwarmTaskNode[];
}

export type SwarmTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'blocked';

export interface SwarmTaskResult {
  taskId: string;
  status: 'completed' | 'failed';
  /** Structured summary from the worker. */
  summary: string;
  /** Artifacts produced (file paths, code snippets, etc.). */
  artifacts: string[];
  /** Issues encountered during execution. */
  issues: string[];
  /** Suggested follow-up steps. */
  nextSteps: string[];
  /** Raw unprocessed output from the worker backend. */
  rawOutput: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Number of retry attempts before final result. */
  retryCount: number;
}

export interface SwarmExecutionSummary {
  objective: string;
  plan: SwarmPlan;
  results: SwarmTaskResult[];
  /** Synthesized final answer combining all worker outputs. */
  finalAnswer: string;
  /** Aggregate stats. */
  stats: {
    totalTasks: number;
    completed: number;
    failed: number;
    blocked: number;
    totalDurationMs: number;
  };
}
