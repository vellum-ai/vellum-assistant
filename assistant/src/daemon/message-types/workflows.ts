// Workflow orchestration run lifecycle events.
//
// Emitted by the `WorkflowRunManager` (run-manager.ts) as a workflow run
// progresses and completes. These are server → client push events only — the
// run is launched via the workflow tool / scheduler / routes (later PRs), not
// via a client message in this union.

import type { WorkflowRunStatus } from "../../workflows/journal-store.js";

// === Server → Client ===

/**
 * Progress push for an in-flight workflow run. Maps the engine's
 * `onProgress` (`phase`/`log`) callback plus the current usage snapshot into a
 * single wire event. `phase` carries the latest `phase(title)`; `message`
 * carries the latest `log(msg)`; only one is set per emission.
 */
export interface WorkflowProgress {
  type: "workflow_progress";
  runId: string;
  /** Latest phase title, when this emission came from a `phase(...)` call. */
  phase?: string;
  /** Run label (the workflow's `meta.name`), for client display. */
  label?: string;
  /** Live agent count at emission time. */
  agentsSpawned: number;
  /** Latest log line, when this emission came from a `log(...)` call. */
  message?: string;
}

/**
 * Terminal push for a workflow run. Carries the final status, counts, token
 * usage, and a human-readable result/error summary the originating
 * conversation also receives via an agent wake.
 */
export interface WorkflowCompleted {
  type: "workflow_completed";
  runId: string;
  status: WorkflowRunStatus;
  agentsSpawned: number;
  inputTokens: number;
  outputTokens: number;
  /** Human-readable result-or-error summary. */
  summary?: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _WorkflowsServerMessages = WorkflowProgress | WorkflowCompleted;
